import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenant } from "@/lib/db";
import { requireSession } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { answer } from "@/lib/qa/answer";
import { enforceLimit } from "@/lib/ratelimit/guard";
import { RL, rlKeys } from "@/lib/ratelimit/config";
import { withRequestLog } from "@/lib/obs/with-request-log";

// POST /api/ask — any authenticated role. Tenant resolved from session, NEVER from the client.
const AskReq = z.object({
  question: z.string().min(1).max(2000),
  conversationId: z.string().uuid().optional(),
});

async function postHandler(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");

  const rid = session.restaurant.id;
  // Cost/abuse guard — reject BEFORE the embed/LLM spend. Minute first (short-circuits the day).
  const overMinute = await enforceLimit(rlKeys.askMin(rid), RL.askPerMinute.limit, RL.askPerMinute.windowSeconds);
  if (overMinute) return overMinute;
  const overDay = await enforceLimit(rlKeys.askDay(rid), RL.askPerDay.limit, RL.askPerDay.windowSeconds);
  if (overDay) return overDay;

  const parsed = AskReq.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  try {
    const result = await withTenant(rid, (tx) => answer(tx, {
      restaurantId: rid,
      userId: session.user.id,
      restaurantName: session.restaurant.name,
      question: parsed.data.question,
      conversationId: parsed.data.conversationId,
    }));
    return NextResponse.json(result);
  } catch (err) {
    console.error("[/api/ask] failed:", err); // never leak internals/DSN/key
    return errorResponse("INTERNAL", "Failed to answer");
  }
}

export const POST = withRequestLog("ask", postHandler);
