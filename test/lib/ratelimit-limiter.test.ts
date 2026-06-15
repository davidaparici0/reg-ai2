import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkRateLimit, cleanupRateLimits } from "@/lib/ratelimit/limiter";

// rate_limits is a global system table (no tenant scope); clean only the keys we create.
afterEach(async () => {
  await db.execute(sql`DELETE FROM rate_limits WHERE key LIKE 'test:%'`);
});

describe("checkRateLimit", () => {
  it("increments per call and flips ok at limit+1", async () => {
    const key = `test:${crypto.randomUUID()}`;
    const r1 = await checkRateLimit(key, 2, 60);
    const r2 = await checkRateLimit(key, 2, 60);
    const r3 = await checkRateLimit(key, 2, 60);
    expect([r1.count, r2.count, r3.count]).toEqual([1, 2, 3]);
    expect([r1.ok, r2.ok, r3.ok]).toEqual([true, true, false]);
    expect(r3.retryAfter).toBeGreaterThan(0);
    expect(r3.retryAfter).toBeLessThanOrEqual(60);
  });

  it("keys are independent (one tenant's count never affects another)", async () => {
    const a = `test:${crypto.randomUUID()}`;
    const b = `test:${crypto.randomUUID()}`;
    await checkRateLimit(a, 5, 60);
    await checkRateLimit(a, 5, 60);
    const rb = await checkRateLimit(b, 5, 60);
    expect(rb.count).toBe(1);
  });

  it("a stale bucket for the same key does not bleed into the current window", async () => {
    const key = `test:${crypto.randomUUID()}`;
    // a bucket from ~2 minutes ago (a different 60s window)
    await db.execute(sql`INSERT INTO rate_limits (key, window_start, count) VALUES (${key}, to_timestamp(floor((extract(epoch FROM now()) - 120) / 60) * 60), 5)`);
    const r = await checkRateLimit(key, 100, 60);
    expect(r.count).toBe(1); // fresh current-window bucket, not 6
  });
});

describe("cleanupRateLimits", () => {
  it("deletes buckets older than a day, keeps recent ones", async () => {
    const oldKey = `test:old:${crypto.randomUUID()}`;
    const newKey = `test:new:${crypto.randomUUID()}`;
    await db.execute(sql`INSERT INTO rate_limits (key, window_start, count) VALUES (${oldKey}, now() - interval '2 days', 1)`);
    await db.execute(sql`INSERT INTO rate_limits (key, window_start, count) VALUES (${newKey}, now(), 1)`);
    await cleanupRateLimits();
    const rows = (await db.execute(sql`SELECT key FROM rate_limits WHERE key IN (${oldKey}, ${newKey})`)).rows as Array<{ key: string }>;
    expect(rows.map((r) => r.key)).toEqual([newKey]);
  });
});
