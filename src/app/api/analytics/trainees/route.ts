// GET per-trainee activity roster (FR-021) — owner|manager, tenant from session.
// users has no RLS, so traineeStats filters restaurant_id explicitly; message/progress data is RLS-scoped.
import { NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { requireSession, hasRole } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { parseWindow } from "@/lib/analytics/window";
import { traineeStats } from "@/lib/analytics/queries";
import { serializeRange, toTraineesResponse } from "@/lib/analytics/serialize";

export async function GET(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");

  const w = parseWindow(new URL(req.url).searchParams, new Date());
  if (!w) return errorResponse("VALIDATION_ERROR", "Invalid window (use 7d, 30d, 90d, or all)");

  const rid = session.restaurant.id;
  const stats = await withTenant(rid, (tx) => traineeStats(tx, rid, w.since));
  return NextResponse.json(toTraineesResponse(w.window, serializeRange(w.since, w.until), stats));
}
