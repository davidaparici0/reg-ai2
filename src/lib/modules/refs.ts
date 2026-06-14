// Resolve content.documentIds / content.menuItemIds against the caller's own tenant.
// Runs inside withTenant, so the SELECTs are RLS-scoped — a foreign id simply isn't
// returned, and the count mismatch => false => the route returns 400 (no leak).
import { inArray } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { documents, menuItems } from "@/db/schema";

export async function assertRefsResolveInTenant(
  tx: Tx, documentIds?: string[], menuItemIds?: string[],
): Promise<boolean> {
  if (documentIds && documentIds.length) {
    const want = new Set(documentIds);
    const rows = await tx.select({ id: documents.id }).from(documents).where(inArray(documents.id, [...want]));
    if (rows.length !== want.size) return false;
  }
  if (menuItemIds && menuItemIds.length) {
    const want = new Set(menuItemIds);
    const rows = await tx.select({ id: menuItems.id }).from(menuItems).where(inArray(menuItems.id, [...want]));
    if (rows.length !== want.size) return false;
  }
  return true;
}
