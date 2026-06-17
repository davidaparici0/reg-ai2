// POST (create) + GET (list) — FR-015. Writes are owner|manager; reads any authenticated
// role (RLS-scoped; trainees may browse). Every write runs the FR-017 rebuild inside the
// same tenant tx, behind the per-tenant advisory lock.
import { NextResponse } from "next/server";
import { desc, lt } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { menuItems } from "@/db/schema";
import { requireSession, hasRole } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { parseDateCursor } from "@/lib/http/cursor";
import { CreateMenuItem, priceToDb } from "@/lib/menu/validate";
import { lockMenuRebuild, rebuildMenuChunks } from "@/lib/menu/rebuild";
import { withRequestLog } from "@/lib/obs/with-request-log";

const PAGE_SIZE = 20;

async function postHandler(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");

  let body: unknown;
  try { body = await req.json(); }
  catch { return errorResponse("VALIDATION_ERROR", "Expected a JSON body"); }
  const parsed = CreateMenuItem.safeParse(body);
  if (!parsed.success) return errorResponse("VALIDATION_ERROR", "Invalid menu item", parsed.error.flatten());

  const rid = session.restaurant.id;
  const input = parsed.data;
  try {
    const item = await withTenant(rid, async (tx) => {
      await lockMenuRebuild(tx, rid);
      const [row] = await tx.insert(menuItems).values({
        restaurantId: rid,
        name: input.name,
        description: input.description ?? null,
        ingredients: input.ingredients ?? null,
        allergens: input.allergens ?? null,
        dietaryFlags: input.dietaryFlags ?? null,
        price: priceToDb(input.price) ?? null,
        ...(input.active === undefined ? {} : { active: input.active }),
      }).returning();
      await rebuildMenuChunks(tx, rid, session.user.id);
      return row;
    });
    return NextResponse.json({ menuItem: item }, { status: 201 });
  } catch (err) {
    // The tx rolled back (row included) — honest, retryable failure. Overwhelmingly the
    // embed call; a DB failure lands here too and the message stays true (nothing changed).
    console.error("[/api/menu-items] POST failed:", err);
    return errorResponse("EMBED_FAILED", "Menu embedding failed; nothing was changed. Retry the request.");
  }
}
export const POST = withRequestLog("menu-items", postHandler);

// GET — any authenticated role. Same cursor idiom as GET /api/documents (created_at desc).
// Includes inactive items: managers must see what's 86'd; invisibility is a Q&A property.
async function getHandler(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");

  const cur = parseDateCursor(new URL(req.url).searchParams.get("cursor"));
  if (!cur.ok) return errorResponse("VALIDATION_ERROR", "Invalid cursor");
  const rows = await withTenant(session.restaurant.id, (tx) =>
    tx.select().from(menuItems)
      .where(cur.value ? lt(menuItems.createdAt, cur.value) : undefined)
      .orderBy(desc(menuItems.createdAt))
      .limit(PAGE_SIZE + 1));

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  return NextResponse.json({
    items: page,
    nextCursor: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
  });
}
export const GET = withRequestLog("menu-items", getHandler);
