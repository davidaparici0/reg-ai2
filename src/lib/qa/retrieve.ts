// Tenant-scoped vector search — the hot path of the crown jewel (FR-010).
// restaurant_id is the first predicate (isolation in the query); RLS is the backstop.
import "server-only";
import { sql } from "drizzle-orm";
import type { Tx } from "@/lib/db";

export type RetrievedChunk = {
  chunkId: string; documentId: string; documentTitle: string; text: string; similarity: number;
};

export async function retrieve(tx: Tx, queryEmbedding: number[], k = 5): Promise<RetrievedChunk[]> {
  // pgvector text repr: "[0.1,0.2,...]" cast to ::vector.
  const vec = `[${queryEmbedding.join(",")}]`;

  // D2 filtered-HNSW recall ladder (transaction-local — no leak):
  //  rung 1: widen the HNSW candidate list; rung 2: iterative scan (pgvector 0.8+) so the
  //  post-filter on restaurant_id still yields up to k rows for a sparse tenant.
  await tx.execute(sql`set local hnsw.ef_search = 100`);
  await tx.execute(sql`set local hnsw.iterative_scan = 'relaxed_order'`);

  const res = await tx.execute(sql`
    select c.id as chunk_id, c.document_id, d.title as document_title, c.text,
           1 - (c.embedding <=> ${vec}::vector) as similarity
    from chunks c
    join documents d on d.id = c.document_id
    where c.restaurant_id = current_setting('app.restaurant_id', true)::uuid
    order by c.embedding <=> ${vec}::vector
    limit ${k}
  `);

  return res.rows.map((r) => ({
    chunkId: r.chunk_id as string,
    documentId: r.document_id as string,
    documentTitle: r.document_title as string,
    text: r.text as string,
    similarity: Number(r.similarity),
  }));
}
