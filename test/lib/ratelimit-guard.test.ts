import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clientIp, enforceLimit, tooManyRequests } from "@/lib/ratelimit/guard";
import { rlKeys } from "@/lib/ratelimit/config";

afterEach(async () => { await db.execute(sql`DELETE FROM rate_limits WHERE key LIKE 'login:test-%'`); });

const reqWith = (xff: string | null) =>
  new Request("http://x/api/auth/login", { headers: xff ? { "x-forwarded-for": xff } : {} });

describe("clientIp", () => {
  it("takes the leftmost x-forwarded-for hop; null when absent", () => {
    expect(clientIp(reqWith("203.0.113.7, 10.0.0.1"))).toBe("203.0.113.7");
    expect(clientIp(reqWith("  198.51.100.2  "))).toBe("198.51.100.2");
    expect(clientIp(reqWith(null))).toBeNull();
  });
});

describe("tooManyRequests", () => {
  it("is a 429 with a Retry-After header", async () => {
    const res = tooManyRequests(42);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect((await res.json()).error.code).toBe("RATE_LIMITED");
  });
});

describe("enforceLimit", () => {
  it("returns null under the limit, a 429 once exceeded", async () => {
    const key = rlKeys.login(`test-${crypto.randomUUID()}`);
    expect(await enforceLimit(key, 1, 60)).toBeNull();        // count 1 <= 1
    const blocked = await enforceLimit(key, 1, 60);           // count 2 > 1
    expect(blocked?.status).toBe(429);
  });
});
