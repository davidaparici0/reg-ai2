import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { restaurants, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { createSession, buildSessionCookie } from "@/lib/auth/session";
import { RegisterReq, toPublicUser } from "@/lib/auth/types";
import { errorResponse } from "@/lib/http/errors";
import { clientIp, enforceLimit } from "@/lib/ratelimit/guard";
import { RL, rlKeys } from "@/lib/ratelimit/config";
import { withRequestLog } from "@/lib/obs/with-request-log";

async function postHandler(req: Request) {
  const ip = clientIp(req);
  if (ip) {
    const limited = await enforceLimit(rlKeys.register(ip), RL.registerPerIp.limit, RL.registerPerIp.windowSeconds);
    if (limited) return limited;
  }
  const parsed = RegisterReq.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("VALIDATION_ERROR", "Invalid registration", parsed.error.flatten());
  }
  const email = parsed.data.email.trim().toLowerCase();

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length) return errorResponse("CONFLICT", "Email already registered");

  const passwordHash = await hashPassword(parsed.data.password);

  try {
    const { user, restaurant } = await db.transaction(async (tx) => {
      const [restaurant] = await tx.insert(restaurants).values({ name: parsed.data.restaurantName }).returning();
      const [user] = await tx.insert(users)
        .values({ restaurantId: restaurant.id, email, passwordHash, role: "owner" }).returning();
      return { user, restaurant };
    });

    const { token, expiresAt } = await createSession(user.id);
    const res = NextResponse.json({ user: toPublicUser(user), restaurant }, { status: 201 });
    res.cookies.set(buildSessionCookie(token, expiresAt));
    return res;
  } catch (err) {
    // Race: two concurrent registrations with the same email can both pass the pre-check
    // above; the unique constraint (Postgres 23505) protects integrity — surface 409, not 500.
    if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "23505") {
      return errorResponse("CONFLICT", "Email already registered");
    }
    console.error("[/api/auth/register] failed:", err);
    return errorResponse("INTERNAL", "Registration failed");
  }
}

export const POST = withRequestLog("auth/register", postHandler);
