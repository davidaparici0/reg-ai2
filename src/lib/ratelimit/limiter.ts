import "server-only";
// Postgres fixed-window rate limiter. Runs on the BASE db (reg_app, no GUC) — rate_limits has
// no RLS. One UPSERT per call atomically increments the (key, window) bucket and returns the
// new count + seconds left in the window (Retry-After). On-brand with "Postgres is the infra".
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export async function checkRateLimit(
  key: string, limit: number, windowSeconds: number,
): Promise<{ ok: boolean; count: number; retryAfter: number }> {
  const rows = (await db.execute(sql`
    INSERT INTO rate_limits (key, window_start, count)
    VALUES (${key}, to_timestamp(floor(extract(epoch FROM now()) / ${windowSeconds}) * ${windowSeconds}), 1)
    ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
    RETURNING count,
      ceil(extract(epoch FROM (window_start + make_interval(secs => ${windowSeconds})) - now()))::int AS retry_after
  `)).rows as Array<{ count: number; retry_after: number }>;
  const row = rows[0];
  if (!row) throw new Error("rate_limits UPSERT returned no row");
  const count = Number(row.count);
  return { ok: count <= limit, count, retryAfter: Number(row.retry_after) };
}

// Opportunistic full-scan cleanup of stale buckets (polling worker). A dedicated window_start index is post-MVP.
export async function cleanupRateLimits(): Promise<void> {
  await db.execute(sql`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
}
