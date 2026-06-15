// Processes ONE already-claimed document, fully tenant-scoped (reg_app + withTenant) so
// every write passes the RLS WITH CHECK. Network work (parse/embed) happens with NO DB
// connection held; the two DB transactions (read blob; persist) are short. On any failure
// the doc is marked 'failed' with the error and the blob is KEPT (a re-upload retries it).
import "server-only";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { documents, documentBlobs, chunks, usageEvents } from "@/db/schema";
import { parse } from "@/lib/ingest/parse";
import { chunk } from "@/lib/ingest/chunk";
import { embed, embeddingCostUsd, EMBEDDING_MODEL, EMBEDDING_DIM } from "@/lib/ai/embeddings";
import type { ClaimedJob } from "@/lib/ingest/claim";

const log = (event: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ event, ...fields })); // never logs bytes or text (FR-025)

export async function processDocument(job: ClaimedJob): Promise<void> {
  log("ingest.start", { jobId: job.id, restaurantId: job.restaurantId });
  try {
    // 1. Read the blob (short read tx), then release the connection for parse/embed.
    const [blob] = await withTenant(job.restaurantId, (tx) =>
      tx.select({ bytes: documentBlobs.bytes }).from(documentBlobs).where(eq(documentBlobs.documentId, job.id)));
    if (!blob) throw new Error("blob missing for document");

    // 2-3. Parse + deterministically chunk (no DB connection held).
    const text = await parse(blob.bytes, job.sourceType);
    const pieces = chunk(text);
    if (pieces.length === 0) throw new Error("no extractable text in document");

    // 4. Embed (network, no DB connection held).
    const { vectors, usageTokens } = await embed(pieces.map((p) => p.text));
    // Safety rail: the embedding shape must match (one 1536-d vector per chunk) before we
    // write — a mismatch becomes a clear failure instead of an opaque pgvector insert error.
    if (vectors.length !== pieces.length || vectors.some((v) => v.length !== EMBEDDING_DIM)) {
      throw new Error(`embedding shape mismatch: expected ${pieces.length} x ${EMBEDDING_DIM}`);
    }

    // 5. Persist atomically: chunks + usage_events + drop blob + mark done.
    await withTenant(job.restaurantId, async (tx) => {
      await tx.insert(chunks).values(pieces.map((p) => ({
        documentId: job.id,
        restaurantId: job.restaurantId,
        chunkIndex: p.chunkIndex,
        text: p.text,
        tokenCount: p.tokenCount,
        embedding: vectors[p.chunkIndex],
      })));
      await tx.insert(usageEvents).values({
        restaurantId: job.restaurantId,
        userId: job.uploadedBy,
        kind: "embedding",
        model: EMBEDDING_MODEL,
        inputTokens: usageTokens,
        outputTokens: 0,
        costUsd: embeddingCostUsd(usageTokens).toFixed(6),
      });
      await tx.delete(documentBlobs).where(eq(documentBlobs.documentId, job.id));
      await tx.update(documents).set({ status: "done", error: null }).where(eq(documents.id, job.id));
    });

    log("ingest.done", { jobId: job.id, chunks: pieces.length, tokens: usageTokens });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("ingest.failed", { jobId: job.id, error: message });
    // Mark failed; KEEP the blob so a re-upload can retry without re-uploading.
    // Fence on status='processing': if a stale-reclaim already handed this job to another
    // worker that finished it (status now done/failed/pending), we no longer hold the claim
    // and must NOT clobber its result — without this, a slow-but-successful run that got
    // reclaimed would have its 'done' overwritten with 'failed' by the losing re-run.
    // If THIS write also fails (DB down), don't throw out of processDocument silently —
    // log it; the doc stays in 'processing' and stale-reclaim (claim.ts) will retry it.
    try {
      await withTenant(job.restaurantId, (tx) =>
        tx.update(documents).set({ status: "failed", error: message.slice(0, 500) })
          .where(and(eq(documents.id, job.id), eq(documents.status, "processing"))));
    } catch (markErr) {
      log("ingest.mark_failed_error", { jobId: job.id, error: String(markErr) });
    }
  }
}
