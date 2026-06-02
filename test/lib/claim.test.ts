import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { restaurants, documents } from "@/db/schema";
import { claimNextDocument, reclaimStaleDocuments, claimPool } from "@/lib/ingest/claim";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

async function seedPendingDoc(name: string) {
  const [r] = await db.insert(restaurants).values({ name }).returning();
  track(r.id);
  const [doc] = await withTenant(r.id, (tx) =>
    tx.insert(documents).values({
      restaurantId: r.id, title: `${name} doc`, sourceType: "pdf", contentHash: `${name}-${crypto.randomUUID()}`,
    }).returning());
  return { restaurant: r, doc };
}

describe("claim (privileged, cross-tenant)", () => {
  it("claims a pending doc across tenants and flips it to processing", async () => {
    const { restaurant, doc } = await seedPendingDoc("CLAIM1");
    const job = await claimNextDocument();
    expect(job).not.toBeNull();
    // The poller sees pending jobs regardless of tenant GUC (RLS-bypassing role).
    expect(job!.restaurantId).toBe(restaurant.id);
    expect(job!.sourceType).toBe("pdf");

    const [after] = await withTenant(restaurant.id, (tx) =>
      tx.select({ status: documents.status }).from(documents).where(eq(documents.id, doc.id)));
    expect(after.status).toBe("processing");
  });

  it("returns null when nothing is pending", async () => {
    while (await claimNextDocument()) { /* drain */ }
    expect(await claimNextDocument()).toBeNull();
  });

  it("reclaims a doc stuck in processing past the timeout", async () => {
    const { restaurant, doc } = await seedPendingDoc("CLAIM2");
    await claimNextDocument(); // -> processing
    await claimPool.query(`UPDATE documents SET updated_at = now() - interval '10 minutes' WHERE id = $1`, [doc.id]);
    const reclaimed = await reclaimStaleDocuments();
    expect(reclaimed).toBeGreaterThanOrEqual(1);
    const [after] = await withTenant(restaurant.id, (tx) =>
      tx.select({ status: documents.status }).from(documents).where(eq(documents.id, doc.id)));
    expect(after.status).toBe("pending");
  });
});
