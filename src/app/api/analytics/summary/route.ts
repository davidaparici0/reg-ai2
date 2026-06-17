// GET tenant analytics summary (FR-022/FR-023) — owner|manager, tenant from session.
// Read-only: aggregates messages/message_sources/usage_events/module_progress under withTenant.
import { NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { requireSession, hasRole } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { parseWindow } from "@/lib/analytics/window";
import { summaryStats } from "@/lib/analytics/queries";
import { serializeRange, toSummaryResponse } from "@/lib/analytics/serialize";
import { withRequestLog } from "@/lib/obs/with-request-log";

async function getHandler(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");

  const w = parseWindow(new URL(req.url).searchParams, new Date());
  if (!w) return errorResponse("VALIDATION_ERROR", "Invalid window (use 7d, 30d, 90d, or all)");

  const rid = session.restaurant.id;
  const stats = await withTenant(rid, (tx) => summaryStats(tx, rid, w.since));
  return NextResponse.json(toSummaryResponse(w.window, serializeRange(w.since, w.until), stats));
}
export const GET = withRequestLog("analytics/summary", getHandler);
