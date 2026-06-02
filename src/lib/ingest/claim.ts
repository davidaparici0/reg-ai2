// The PRIVILEGED, cross-tenant scheduler half of the worker. Scheduling is inherently
// cross-tenant (the poller must see every tenant's pending jobs), so it uses a role that
// bypasses RLS (WORKER_DATABASE_URL = the reg superuser in dev; a least-priv reg_worker
// in prod, Phase 8). The status flip to 'processing' IS the lock — no long-held DB lock.
// All TENANT-SCOPED work (read blob, write chunks) happens elsewhere as reg_app + withTenant.
import "server-only";
import { Pool } from "pg";
import type { SourceType } from "@/lib/ingest/parse";

const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) {
  throw new Error("WORKER_DATABASE_URL is not set (server-only). Needs an RLS-bypassing role (dev: reg superuser).");
}

// max:4 (not db.ts's 10): the worker processes one document at a time, so the claim pool
// only needs a small amount of headroom (claim + reclaim + a little slack), never 10.
const globalForClaim = globalThis as unknown as { _workerPool?: Pool };
export const claimPool = globalForClaim._workerPool ?? new Pool({ connectionString, max: 4 });
if (process.env.NODE_ENV !== "production") globalForClaim._workerPool = claimPool;

export type ClaimedJob = {
  id: string;
  restaurantId: string;
  title: string;
  sourceType: SourceType;
  uploadedBy: string | null;
};

// Atomically claim ONE pending doc: SKIP LOCKED avoids worker collisions; the status
// flip means no other worker re-claims it. Returns null if nothing is pending.
// Operational note: if this ALWAYS returns null while docs are clearly pending, check that
// WORKER_DATABASE_URL points at an RLS-bypassing role — reg_app sees no rows (FORCE RLS).
export async function claimNextDocument(): Promise<ClaimedJob | null> {
  const { rows } = await claimPool.query<ClaimedJob>(
    `UPDATE documents SET status='processing', updated_at=now()
     WHERE id = (
       SELECT id FROM documents WHERE status='pending'
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
     )
     RETURNING id,
               restaurant_id AS "restaurantId",
               title,
               source_type   AS "sourceType",
               uploaded_by   AS "uploadedBy"`,
  );
  return rows[0] ?? null;
}

// Crash recovery: a doc left in 'processing' past the timeout returns to 'pending'.
export async function reclaimStaleDocuments(maxAgeMs = 5 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const { rowCount } = await claimPool.query(
    `UPDATE documents SET status='pending', updated_at=now()
     WHERE status='processing' AND updated_at < $1`,
    [cutoff],
  );
  return rowCount ?? 0;
}
