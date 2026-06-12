// PATCH (partial update incl. the 86-tonight active toggle) + DELETE (hard) — FR-015.
// Foreign/missing/non-uuid ids -> 404 (RLS hides foreign rows; anti-enumeration, same as
// GET /api/documents/:id). Both writes rebuild the menu chunks in-tx (FR-017).
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { menuItems } from "@/db/schema";
import { requireSession, hasRole } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { PatchMenuItem, priceToDb } from "@/lib/menu/validate";
import { lockMenuRebuild, rebuildMenuChunks } from "@/lib/menu/rebuild";

const Uuid = z.string().uuid();

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");

  const { id } = await ctx.params;
  if (!Uuid.safeParse(id).success) return errorResponse("NOT_FOUND", "Menu item not found");

  let body: unknown;
  try { body = await req.json(); }
  catch { return errorResponse("VALIDATION_ERROR", "Expected a JSON body"); }
  const parsed = PatchMenuItem.safeParse(body);
  if (!parsed.success) return errorResponse("VALIDATION_ERROR", "Invalid menu item patch", parsed.error.flatten());

  const rid = session.restaurant.id;
  const input = parsed.data;
  try {
    const updated = await withTenant(rid, async (tx) => {
      await lockMenuRebuild(tx, rid);
      // Only fields present in the patch — absent keys must not overwrite existing values
      // (explicit null IS present and clears the nullable column).
      const [row] = await tx.update(menuItems).set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.ingredients !== undefined ? { ingredients: input.ingredients } : {}),
        ...(input.allergens !== undefined ? { allergens: input.allergens } : {}),
        ...(input.dietaryFlags !== undefined ? { dietaryFlags: input.dietaryFlags } : {}),
        ...(input.price !== undefined ? { price: priceToDb(input.price) } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      }).where(eq(menuItems.id, id)).returning();
      if (!row) return null;                       // RLS hid it (foreign) or missing
      await rebuildMenuChunks(tx, rid, session.user.id);
      return row;
    });
    if (!updated) return errorResponse("NOT_FOUND", "Menu item not found");
    return NextResponse.json({ menuItem: updated });
  } catch (err) {
    console.error("[/api/menu-items/:id] PATCH failed:", err);
    return errorResponse("EMBED_FAILED", "Menu embedding failed; nothing was changed. Retry the request.");
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");

  const { id } = await ctx.params;
  if (!Uuid.safeParse(id).success) return errorResponse("NOT_FOUND", "Menu item not found");

  const rid = session.restaurant.id;
  try {
    const deleted = await withTenant(rid, async (tx) => {
      await lockMenuRebuild(tx, rid);
      const [row] = await tx.delete(menuItems).where(eq(menuItems.id, id)).returning({ id: menuItems.id });
      if (!row) return null;
      await rebuildMenuChunks(tx, rid, session.user.id);
      return row;
    });
    if (!deleted) return errorResponse("NOT_FOUND", "Menu item not found");
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error("[/api/menu-items/:id] DELETE failed:", err);
    return errorResponse("EMBED_FAILED", "Menu embedding failed; nothing was changed. Retry the request.");
  }
}
