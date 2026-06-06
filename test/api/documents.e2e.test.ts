import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { chunks } from "@/db/schema";
import { cleanup } from "../helpers/db";
import { registerOwner } from "../helpers/auth";
import { makeMinimalPdf } from "../helpers/pdf";

vi.mock("@/lib/ai/embeddings", () => ({
  EMBEDDING_MODEL: "text-embedding-3-small",
  EMBEDDING_DIM: 1536,
  embeddingCostUsd: (t: number) => t * (0.02 / 1_000_000),
  embed: vi.fn(async (texts: string[]) => ({
    vectors: texts.map(() => Array(1536).fill(0.03)),
    usageTokens: texts.length * 7,
  })),
}));

import { POST } from "@/app/api/documents/route";
import { GET as getStatus } from "@/app/api/documents/[id]/route";
import { runOnce } from "@/worker/index";

afterEach(cleanup);

function uploadReq(cookie: string, bytes: Buffer) {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(bytes)], "menu.pdf", { type: "application/pdf" }));
  return new Request("http://x/api/documents", { method: "POST", headers: { cookie }, body: fd });
}
const statusReq = (cookie: string, id: string) =>
  getStatus(new Request("http://x/api/documents/" + id, { headers: { cookie } }), { params: Promise.resolve({ id }) });

describe("ingestion end-to-end", () => {
  it("upload -> worker -> done + queryable tenant-scoped chunks; re-upload dedups; other tenant cannot see it", async () => {
    const owner = await registerOwner();
    const bytes = makeMinimalPdf("End to end grounded ingestion proof");

    // Upload (202 pending).
    const up = await (await POST(uploadReq(owner.cookie, bytes))).json();

    // Worker processes exactly one job.
    const processedId = await runOnce();
    expect(processedId).toBe(up.documentId);

    // Status now done with a chunk count.
    const status = await (await statusReq(owner.cookie, up.documentId)).json();
    expect(status.status).toBe("done");
    expect(status.chunkCount).toBeGreaterThan(0);

    // Chunks exist, all scoped to this tenant, 1536-d embeddings.
    const ownerChunks = await withTenant(owner.restaurant.id, (tx) =>
      tx.select().from(chunks).where(eq(chunks.documentId, up.documentId)));
    expect(ownerChunks.length).toBe(status.chunkCount);
    expect(ownerChunks.every((c) => c.restaurantId === owner.restaurant.id)).toBe(true);
    expect(ownerChunks[0].embedding).toHaveLength(1536);

    // Re-upload identical bytes -> 200, no new job, no duplicate chunks.
    const dup = await POST(uploadReq(owner.cookie, bytes));
    expect(dup.status).toBe(200);
    expect(await runOnce()).toBeNull();
    const afterDup = await withTenant(owner.restaurant.id, (tx) =>
      tx.select().from(chunks).where(eq(chunks.documentId, up.documentId)));
    expect(afterDup.length).toBe(ownerChunks.length);

    // Isolation: a second tenant sees neither the document nor its chunks.
    const other = await registerOwner();
    expect((await statusReq(other.cookie, up.documentId)).status).toBe(404);
    const otherView = await withTenant(other.restaurant.id, (tx) =>
      tx.select().from(chunks).where(eq(chunks.documentId, up.documentId)));
    expect(otherView).toHaveLength(0);
  });
});
