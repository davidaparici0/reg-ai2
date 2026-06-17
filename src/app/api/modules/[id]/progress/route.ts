// PUT (caller upserts their own progress) + GET (manager roster) — FR-019.
// PUT is any authenticated user (records their own row); GET is owner|manager.
// users has no RLS, so the roster filters restaurant_id explicitly; module_progress is RLS-scoped.
import { NextResponse } from "next/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { modules, moduleProgress, users } from "@/db/schema";
import { requireSession, hasRole } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { ProgressUpdate } from "@/lib/modules/validate";
import { normalizeProgress } from "@/lib/modules/serialize";
import { withRequestLog } from "@/lib/obs/with-request-log";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function putHandler(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  const { id } = await ctx.params;
  if (!UUID.test(id)) return errorResponse("NOT_FOUND", "Module not found");

  let body: unknown;
  try { body = await req.json(); }
  catch { return errorResponse("VALIDATION_ERROR", "Expected a JSON body"); }
  const parsed = ProgressUpdate.safeParse(body);
  if (!parsed.success) return errorResponse("VALIDATION_ERROR", "Invalid progress update", parsed.error.flatten());

  const rid = session.restaurant.id;
  const uid = session.user.id;
  const status = parsed.data.status;
  const now = new Date();
  const row = await withTenant(rid, async (tx) => {
    const [mod] = await tx.select({ id: modules.id }).from(modules).where(eq(modules.id, id)).limit(1);
    if (!mod) return null;
    const [p] = await tx.insert(moduleProgress).values({
      moduleId: id, userId: uid, restaurantId: rid, status,
      startedAt: now, completedAt: status === "completed" ? now : null,
    }).onConflictDoUpdate({
      target: [moduleProgress.moduleId, moduleProgress.userId],
      set: {
        status,
        startedAt: sql`coalesce(${moduleProgress.startedAt}, now())`,        // first start wins
        completedAt: status === "completed" ? sql`coalesce(${moduleProgress.completedAt}, now())` : null,
      },
    }).returning();
    return p;
  });
  if (!row) return errorResponse("NOT_FOUND", "Module not found");
  return NextResponse.json({ progress: { moduleId: id, ...normalizeProgress(row) } });
}
export const PUT = withRequestLog("modules/:id/progress", putHandler);

async function getHandler(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");
  const { id } = await ctx.params;
  if (!UUID.test(id)) return errorResponse("NOT_FOUND", "Module not found");

  const rid = session.restaurant.id;
  const rows = await withTenant(rid, async (tx) => {
    const [mod] = await tx.select({ id: modules.id }).from(modules).where(eq(modules.id, id)).limit(1);
    if (!mod) return null;
    return tx.select({
      userId: users.id, email: users.email, role: users.role,
      status: moduleProgress.status, startedAt: moduleProgress.startedAt, completedAt: moduleProgress.completedAt,
    })
      .from(users)
      .leftJoin(moduleProgress, and(eq(moduleProgress.userId, users.id), eq(moduleProgress.moduleId, id)))
      .where(and(eq(users.restaurantId, rid), eq(users.role, "trainee")))
      .orderBy(asc(users.email));
  });
  if (rows === null) return errorResponse("NOT_FOUND", "Module not found");
  return NextResponse.json({
    moduleId: id,
    roster: rows.map((r) => ({
      user: { id: r.userId, email: r.email, role: r.role },
      ...normalizeProgress(r.status ? { status: r.status, startedAt: r.startedAt, completedAt: r.completedAt } : null),
    })),
  });
}
export const GET = withRequestLog("modules/:id/progress", getHandler);
