import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { restaurants, documents } from "@/db/schema";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

async function seedRestaurantWithDoc(name: string) {
  const [r] = await db.insert(restaurants).values({ name }).returning();
  track(r.id);
  // documents has RLS+FORCE: inserting requires the GUC set (exercises WITH CHECK).
  const rows = await withTenant(r.id, (tx) =>
    tx.insert(documents).values({
      restaurantId: r.id, title: `${name} doc`, sourceType: "text", contentHash: `${name}-hash`,
    }).returning(),
  );
  return { restaurant: r, doc: rows[0] };
}

describe("withTenant + RLS", () => {
  it("scopes reads to the GUC tenant and hides other tenants' rows", async () => {
    const a = await seedRestaurantWithDoc("AAA");
    const b = await seedRestaurantWithDoc("BBB");

    const aDocs = await withTenant(a.restaurant.id, (tx) => tx.select().from(documents));
    expect(aDocs.map((d) => d.id)).toEqual([a.doc.id]); // only A's

    // B's doc id is invisible under A's GUC (RLS backstop, not app logic).
    const leak = await withTenant(a.restaurant.id, (tx) =>
      tx.select().from(documents).where(eq(documents.id, b.doc.id)),
    );
    expect(leak).toHaveLength(0);
  });

  it("WITH CHECK blocks inserting a row for a different (real) tenant", async () => {
    const a = await seedRestaurantWithDoc("CCC");
    const b = await seedRestaurantWithDoc("DDD"); // a real restaurant, so the FK passes
    // Under A's GUC, inserting a row tagged for B fails the policy's WITH CHECK (not the FK).
    await expect(
      withTenant(a.restaurant.id, (tx) =>
        tx.insert(documents).values({
          restaurantId: b.restaurant.id, title: "evil", sourceType: "text", contentHash: "evil-hash",
        }),
      ),
    ).rejects.toThrow();
  });
});
