import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clientIp, enforceLimit, tooManyRequests } from "@/lib/ratelimit/guard";
import { rlKeys } from "@/lib/ratelimit/config";

afterEach(async () => { await db.execute(sql`DELETE FROM rate_limits WHERE key LIKE 'login:test-%'`); });

const reqWith = (xff: string | null, fly?: string) =>
  new Request("http://x/api/auth/login", {
    headers: {
      ...(xff ? { "x-forwarded-for": xff } : {}),
      ...(fly ? { "fly-client-ip": fly } : {}),
    },
  });

describe("clientIp", () => {
  it("trusts the RIGHTMOST x-forwarded-for hop (proxy-appended client), not the spoofable leftmost", () => {
    // Attacker spoofs the leftmost token; the trusted edge appends the real client on the right.
    // Trusting the leftmost would let them bypass the limit (fresh bucket per forged IP) and
    // grief a victim (pre-exhaust their bucket). The rightmost hop is what our proxy observed.
    expect(clientIp(reqWith("6.6.6.6, 203.0.113.7"))).toBe("203.0.113.7");
    expect(clientIp(reqWith("198.51.100.2"))).toBe("198.51.100.2");        // single hop
    expect(clientIp(reqWith("  198.51.100.2 , 10.0.0.1  "))).toBe("10.0.0.1"); // trims
  });

  it("prefers Fly-Client-IP (unforgeable) over x-forwarded-for when present", () => {
    expect(clientIp(reqWith("6.6.6.6", "198.51.100.9"))).toBe("198.51.100.9");
  });

  it("is null when no proxy header is present (dev/test => limiting skipped)", () => {
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
