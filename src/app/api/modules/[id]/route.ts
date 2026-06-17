// GET (detail + caller progress) · PATCH (partial) · DELETE (hard) — FR-018.
// Foreign/missing/non-uuid ids -> 404 (RLS hides foreign rows; anti-enumeration).
// DELETE cascades the module's progress rows via the module_progress FK.
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { withTenant, type Tx } from "@/lib/db";
import { modules, moduleProgress } from "@/db/schema";
import { requireSession, hasRole } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { PatchModule } from "@/lib/modules/validate";
import { assertRefsResolveInTenant } from "@/lib/modules/refs";
import { normalizeProgress, toDetail } from "@/lib/modules/serialize";
import { withRequestLog } from "@/lib/obs/with-request-log";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function callerProgress(tx: Tx, moduleId: string, userId: string) {
  const [p] = await tx.select({
    status: moduleProgress.status, startedAt: moduleProgress.startedAt, completedAt: moduleProgress.completedAt,
  }).from(moduleProgress)
    .where(and(eq(moduleProgress.moduleId, moduleId), eq(moduleProgress.userId, userId))).limit(1);
  return p ?? null;
}

async function getHandler(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  const { id } = await ctx.params;
  if (!UUID.test(id)) return errorResponse("NOT_FOUND", "Module not found");

  const uid = session.user.id;
  const result = await withTenant(session.restaurant.id, async (tx) => {
    const [m] = await tx.select().from(modules).where(eq(modules.id, id)).limit(1);
    if (!m) return null;
    return { m, p: await callerProgress(tx, id, uid) };
  });
  if (!result) return errorResponse("NOT_FOUND", "Module not found");
  return NextResponse.json({ module: toDetail(result.m, normalizeProgress(result.p)) });
}
export const GET = withRequestLog("modules/:id", getHandler);

async function patchHandler(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");
  const { id } = await ctx.params;
  if (!UUID.test(id)) return errorResponse("NOT_FOUND", "Module not found");

  let body: unknown;
  try { body = await req.json(); }
  catch { return errorResponse("VALIDATION_ERROR", "Expected a JSON body"); }
  const parsed = PatchModule.safeParse(body);
  if (!parsed.success) return errorResponse("VALIDATION_ERROR", "Invalid module patch", parsed.error.flatten());

  const uid = session.user.id;
  const input = parsed.data;
  const outcome = await withTenant(session.restaurant.id, async (tx): Promise<"refs" | "missing" | { m: typeof modules.$inferSelect; p: Awaited<ReturnType<typeof callerProgress>> }> => {
    if (input.content && !await assertRefsResolveInTenant(tx, input.content.documentIds, input.content.menuItemIds)) return "refs";
    const [m] = await tx.update(modules).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
    }).where(eq(modules.id, id)).returning();
    if (!m) return "missing";
    return { m, p: await callerProgress(tx, id, uid) };
  });
  if (outcome === "refs") return errorResponse("VALIDATION_ERROR", "documentIds/menuItemIds must reference items in your restaurant");
  if (outcome === "missing") return errorResponse("NOT_FOUND", "Module not found");
  return NextResponse.json({ module: toDetail(outcome.m, normalizeProgress(outcome.p)) });
}
export const PATCH = withRequestLog("modules/:id", patchHandler);

async function deleteHandler(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");
  const { id } = await ctx.params;
  if (!UUID.test(id)) return errorResponse("NOT_FOUND", "Module not found");

  const deleted = await withTenant(session.restaurant.id, async (tx) => {
    const [row] = await tx.delete(modules).where(eq(modules.id, id)).returning({ id: modules.id });
    return row ?? null;
  });
  if (!deleted) return errorResponse("NOT_FOUND", "Module not found");
  return new NextResponse(null, { status: 204 });
}
export const DELETE = withRequestLog("modules/:id", deleteHandler);
