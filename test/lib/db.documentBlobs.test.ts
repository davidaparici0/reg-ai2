import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { restaurants, documents, documentBlobs } from "@/db/schema";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

async function seedDocWithBlob(name: string) {
  const [r] = await db.insert(restaurants).values({ name }).returning();
  track(r.id);
  return withTenant(r.id, async (tx) => {
    const [doc] = await tx.insert(documents).values({
      restaurantId: r.id, title: `${name} doc`, sourceType: "pdf", contentHash: `${name}-hash`,
    }).returning();
    await tx.insert(documentBlobs).values({
      documentId: doc.id, restaurantId: r.id, bytes: Buffer.from(`${name}-bytes`),
    });
    return { restaurant: r, doc };
  });
}

describe("document_blobs + RLS", () => {
  it("scopes blob reads to the GUC tenant", async () => {
    const a = await seedDocWithBlob("BLOBA");
    const b = await seedDocWithBlob("BLOBB");

    const aBlobs = await withTenant(a.restaurant.id, (tx) => tx.select().from(documentBlobs));
    expect(aBlobs.map((x) => x.documentId)).toEqual([a.doc.id]);

    const leak = await withTenant(a.restaurant.id, (tx) =>
      tx.select().from(documentBlobs).where(eq(documentBlobs.documentId, b.doc.id)));
    expect(leak).toHaveLength(0);
  });

  it("round-trips bytea content", async () => {
    const a = await seedDocWithBlob("BLOBC");
    const [row] = await withTenant(a.restaurant.id, (tx) =>
      tx.select().from(documentBlobs).where(eq(documentBlobs.documentId, a.doc.id)));
    expect(Buffer.isBuffer(row.bytes)).toBe(true);
    expect(row.bytes.toString()).toBe("BLOBC-bytes");
  });

  it("WITH CHECK blocks writing a blob for a different tenant", async () => {
    const a = await seedDocWithBlob("BLOBD");
    const [rB] = await db.insert(restaurants).values({ name: "BLOBE" }).returning();
    track(rB.id);
    // A real document in B with NO blob yet (so the blob PK is free).
    const [bDoc] = await withTenant(rB.id, (tx) =>
      tx.insert(documents).values({
        restaurantId: rB.id, title: "B doc", sourceType: "pdf", contentHash: `BLOBE-${crypto.randomUUID()}`,
      }).returning());
    // Under A's GUC, inserting a blob tagged for B fails the policy's WITH CHECK (not the FK).
    await expect(
      withTenant(a.restaurant.id, (tx) =>
        tx.insert(documentBlobs).values({ documentId: bDoc.id, restaurantId: rB.id, bytes: Buffer.from("evil") })),
    ).rejects.toThrow();
  });
});
