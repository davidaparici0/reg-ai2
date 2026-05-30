import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { restaurants } from "@/db/schema";

const created: string[] = [];

export function track(restaurantId: string): void {
  created.push(restaurantId);
}

// Deleting restaurants (no RLS) cascades to users/sessions/documents/chunks.
// FK cascade bypasses RLS, so this works without setting the GUC.
export async function cleanup(): Promise<void> {
  const ids = created.splice(0);
  if (ids.length) await db.delete(restaurants).where(inArray(restaurants.id, ids));
}
