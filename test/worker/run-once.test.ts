import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { restaurants, documents, documentBlobs } from "@/db/schema";
import { track, cleanup } from "../helpers/db";
import { makeMinimalPdf } from "../helpers/pdf";

vi.mock("@/lib/ai/embeddings", () => ({
  EMBEDDING_MODEL: "text-embedding-3-small",
  EMBEDDING_DIM: 1536,
  embeddingCostUsd: (t: number) => t * (0.02 / 1_000_000),
  embed: vi.fn(async (texts: string[]) => ({
    vectors: texts.map(() => Array(1536).fill(0.02)),
    usageTokens: texts.length * 5,
  })),
}));

import { runOnce } from "@/worker/index";

afterEach(cleanup);

describe("runOnce()", () => {
  it("claims + processes one pending doc and returns its id", async () => {
    const [r] = await db.insert(restaurants).values({ name: "RUN1" }).returning();
    track(r.id);
    const [doc] = await withTenant(r.id, async (tx) => {
      const [d] = await tx.insert(documents).values({
        restaurantId: r.id, title: "menu", sourceType: "pdf", contentHash: crypto.randomUUID(),
      }).returning();
      await tx.insert(documentBlobs).values({
        documentId: d.id, restaurantId: r.id, bytes: makeMinimalPdf("worker run-once test"),
      });
      return [d];
    });

    const processedId = await runOnce();
    expect(processedId).toBe(doc.id);
    const [after] = await withTenant(r.id, (tx) =>
      tx.select({ status: documents.status }).from(documents).where(eq(documents.id, doc.id)));
    expect(after.status).toBe("done");
  });

  it("returns null when there is nothing to do", async () => {
    const { claimNextDocument } = await import("@/lib/ingest/claim");
    while (await claimNextDocument()) { /* drain anything pending from other tests */ }
    expect(await runOnce()).toBeNull();
  });
});
