import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { restaurants, documents, documentBlobs, chunks, usageEvents } from "@/db/schema";
import { track, cleanup } from "../helpers/db";
import { makeMinimalPdf } from "../helpers/pdf";

vi.mock("@/lib/ai/embeddings", () => ({
  EMBEDDING_MODEL: "text-embedding-3-small",
  EMBEDDING_DIM: 1536,
  embeddingCostUsd: (t: number) => t * (0.02 / 1_000_000),
  embed: vi.fn(async (texts: string[]) => ({
    vectors: texts.map(() => Array(1536).fill(0.01)),
    usageTokens: texts.length * 10,
  })),
}));

import { processDocument } from "@/lib/ingest/process-document";

afterEach(cleanup);

async function seedClaimedPdf(name: string, bytes: Buffer) {
  const [r] = await db.insert(restaurants).values({ name }).returning();
  track(r.id);
  const job = await withTenant(r.id, async (tx) => {
    const [doc] = await tx.insert(documents).values({
      restaurantId: r.id, title: `${name}`, sourceType: "pdf",
      contentHash: `${name}-${crypto.randomUUID()}`, status: "processing",
    }).returning();
    await tx.insert(documentBlobs).values({ documentId: doc.id, restaurantId: r.id, bytes });
    return { id: doc.id, restaurantId: r.id, title: doc.title, sourceType: "pdf" as const, uploadedBy: null };
  });
  return { restaurant: r, job };
}

describe("processDocument()", () => {
  it("parses, chunks, embeds, writes tenant-scoped chunks, drops the blob, marks done", async () => {
    const { restaurant, job } = await seedClaimedPdf("PROC1", makeMinimalPdf("Grounded answers require citations"));
    await processDocument(job);

    const rows = await withTenant(restaurant.id, async (tx) => ({
      doc: (await tx.select().from(documents).where(eq(documents.id, job.id)))[0],
      chunks: await tx.select().from(chunks).where(eq(chunks.documentId, job.id)),
      blobs: await tx.select().from(documentBlobs).where(eq(documentBlobs.documentId, job.id)),
      usage: await tx.select().from(usageEvents).where(eq(usageEvents.restaurantId, restaurant.id)),
    }));

    expect(rows.doc.status).toBe("done");
    expect(rows.chunks.length).toBeGreaterThan(0);
    expect(rows.chunks.every((c) => c.restaurantId === restaurant.id)).toBe(true);
    expect(rows.chunks[0].embedding).toHaveLength(1536);
    expect(rows.blobs).toHaveLength(0);                 // dropped on success
    expect(rows.usage.some((u) => u.kind === "embedding")).toBe(true);
  });

  it("marks the doc failed (and KEEPS the blob) on an unparseable file", async () => {
    const { restaurant, job } = await seedClaimedPdf("PROC2", Buffer.from("definitely not a pdf"));
    await processDocument(job);

    const { doc, blobs, chunkRows } = await withTenant(restaurant.id, async (tx) => ({
      doc: (await tx.select().from(documents).where(eq(documents.id, job.id)))[0],
      blobs: await tx.select().from(documentBlobs).where(eq(documentBlobs.documentId, job.id)),
      chunkRows: await tx.select().from(chunks).where(eq(chunks.documentId, job.id)),
    }));

    expect(doc.status).toBe("failed");
    expect(doc.error).toBeTruthy();
    expect(blobs).toHaveLength(1);                      // kept for retry
    expect(chunkRows).toHaveLength(0);                  // atomic: no partial chunks
  });

  it("does not clobber an already-done doc to 'failed' when a stale-reclaim re-run loses the chunk race", async () => {
    const { restaurant, job } = await seedClaimedPdf("FENCE", makeMinimalPdf("citations ground every answer"));
    // Simulate the WINNING worker having finished: chunk #0 written + status flipped to done.
    await withTenant(restaurant.id, async (tx) => {
      await tx.insert(chunks).values({
        documentId: job.id, restaurantId: restaurant.id, chunkIndex: 0, text: "x", tokenCount: 1, embedding: Array(1536).fill(0),
      });
      await tx.update(documents).set({ status: "done", error: null }).where(eq(documents.id, job.id));
    });

    // A stale-reclaim re-run of the SAME job re-inserts chunk #0 => unique violation. Its failure
    // handler must NOT mark the (already-done) doc failed: the fail write is fenced on the claim
    // still being held (status='processing'), which it no longer is.
    await processDocument(job);

    const doc = await withTenant(restaurant.id, (tx) =>
      tx.select().from(documents).where(eq(documents.id, job.id)).then((r) => r[0]));
    expect(doc.status).toBe("done");                    // fence prevents the clobber
  });
});
