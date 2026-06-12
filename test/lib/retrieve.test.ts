import { afterEach, describe, expect, it } from "vitest";
import { db, withTenant } from "@/lib/db";
import { restaurants, documents, chunks } from "@/db/schema";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

// A 1536-d basis vector with a single 1 at position i (cosine-friendly fixtures).
const basis = (i: number) => { const v = Array(1536).fill(0); v[i] = 1; return v; };

async function seedChunk(restaurantId: string, docId: string, idx: number, text: string, emb: number[]) {
  await withTenant(restaurantId, (tx) =>
    tx.insert(chunks).values({
      documentId: docId, restaurantId, chunkIndex: idx, text, tokenCount: 5, embedding: emb,
    }));
}

async function seedRestaurant(name: string) {
  const [r] = await db.insert(restaurants).values({ name }).returning();
  track(r.id);
  const [doc] = await withTenant(r.id, (tx) =>
    tx.insert(documents).values({
      restaurantId: r.id, title: `${name} doc`, sourceType: "text", contentHash: `${name}-${crypto.randomUUID()}`, status: "done",
    }).returning());
  return { id: r.id, docId: doc.id };
}

describe("retrieve()", () => {
  it("returns this tenant's chunks ordered by cosine similarity", async () => {
    const a = await seedRestaurant("RETA");
    await seedChunk(a.id, a.docId, 0, "alpha chunk", basis(0));
    await seedChunk(a.id, a.docId, 1, "beta chunk", basis(1));
    const { retrieve } = await import("@/lib/qa/retrieve");

    const res = await withTenant(a.id, (tx) => retrieve(tx, basis(0), 5));
    expect(res[0].text).toBe("alpha chunk");
    expect(res[0].similarity).toBeCloseTo(1, 5);
    expect(res[0].documentTitle).toBe("RETA doc");
    expect(res[1].similarity).toBeCloseTo(0, 5);
  });

  it("never returns another tenant's chunks", async () => {
    const a = await seedRestaurant("RETB");
    const b = await seedRestaurant("RETC");
    await seedChunk(b.id, b.docId, 0, "secret B chunk", basis(0));
    const { retrieve } = await import("@/lib/qa/retrieve");

    const res = await withTenant(a.id, (tx) => retrieve(tx, basis(0), 5));
    expect(res).toHaveLength(0);
  });
});
