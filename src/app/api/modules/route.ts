// POST (create) + GET (list) — FR-018. Writes are owner|manager; reads any authenticated
// role (trainees browse the curriculum). List is ordered by (position, id) ascending and
// embeds the caller's own progress per module. Modules never touch embeddings/chunks.
import { NextResponse } from "next/server";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/lib/db";
import { modules, moduleProgress } from "@/db/schema";
import { requireSession, hasRole } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { CreateModule } from "@/lib/modules/validate";
import { assertRefsResolveInTenant } from "@/lib/modules/refs";
import { normalizeProgress, toDetail, toSummary } from "@/lib/modules/serialize";
import { withRequestLog } from "@/lib/obs/with-request-log";

const PAGE_SIZE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function nextPosition(tx: Tx): Promise<number> {
  const [row] = await tx.select({ max: sql<number | null>`max(${modules.position})` }).from(modules);
  return Number(row?.max ?? -1) + 1;
}

async function postHandler(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");

  let body: unknown;
  try { body = await req.json(); }
  catch { return errorResponse("VALIDATION_ERROR", "Expected a JSON body"); }
  const parsed = CreateModule.safeParse(body);
  if (!parsed.success) return errorResponse("VALIDATION_ERROR", "Invalid module", parsed.error.flatten());

  const rid = session.restaurant.id;
  const input = parsed.data;
  const row = await withTenant(rid, async (tx) => {
    if (!await assertRefsResolveInTenant(tx, input.content.documentIds, input.content.menuItemIds)) return null;
    const position = input.position ?? await nextPosition(tx);
    const [created] = await tx.insert(modules).values({
      restaurantId: rid,
      title: input.title,
      description: input.description ?? null,
      content: input.content,
      position,
    }).returning();
    return created;
  });
  if (!row) return errorResponse("VALIDATION_ERROR", "documentIds/menuItemIds must reference items in your restaurant");
  return NextResponse.json({ module: toDetail(row, normalizeProgress(null)) }, { status: 201 });
}
export const POST = withRequestLog("modules", postHandler);

function parseCursor(raw: string | null): { position: number; id: string } | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  const position = Number(raw.slice(0, dot));
  const id = raw.slice(dot + 1);
  if (dot < 0 || !Number.isInteger(position) || position < 0 || !UUID.test(id)) throw new Error("bad cursor");
  return { position, id };
}

async function getHandler(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");

  let cursor: { position: number; id: string } | null;
  try { cursor = parseCursor(new URL(req.url).searchParams.get("cursor")); }
  catch { return errorResponse("VALIDATION_ERROR", "Invalid cursor"); }

  const uid = session.user.id;
  const rows = await withTenant(session.restaurant.id, (tx) =>
    tx.select({
      m: modules,
      status: moduleProgress.status,
      startedAt: moduleProgress.startedAt,
      completedAt: moduleProgress.completedAt,
    })
      .from(modules)
      .leftJoin(moduleProgress, and(eq(moduleProgress.moduleId, modules.id), eq(moduleProgress.userId, uid)))
      .where(cursor
        ? or(gt(modules.position, cursor.position), and(eq(modules.position, cursor.position), gt(modules.id, cursor.id)))
        : undefined)
      .orderBy(asc(modules.position), asc(modules.id))
      .limit(PAGE_SIZE + 1));

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const items = page.map((r) =>
    toSummary(r.m, normalizeProgress(r.status ? { status: r.status, startedAt: r.startedAt, completedAt: r.completedAt } : null)));
  const last = page[page.length - 1];
  return NextResponse.json({
    modules: items,
    nextCursor: hasMore && last ? `${last.m.position}.${last.m.id}` : null,
  });
}
export const GET = withRequestLog("modules", getHandler);
