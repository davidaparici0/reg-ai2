import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as register } from "@/app/api/auth/register/route";
import { checkRateLimit } from "@/lib/ratelimit/limiter";
import { rlKeys } from "@/lib/ratelimit/config";
import { RL } from "@/lib/ratelimit/config";
import { cleanup } from "../helpers/db";

afterEach(cleanup);
afterEach(async () => { await db.execute(sql`DELETE FROM rate_limits WHERE key LIKE 'login:%' OR key LIKE 'register:%'`); });

const loginReq = (ip: string | null, body: unknown) =>
  login(new Request("http://x/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) },
    body: JSON.stringify(body),
  }));

describe("login rate limiting", () => {
  it("429s once an IP exceeds the window, with Retry-After", async () => {
    const ip = `198.51.100.${Math.floor(1)}`;
    for (let i = 0; i < RL.loginPerIp.limit; i++) await checkRateLimit(rlKeys.login(ip), RL.loginPerIp.limit, RL.loginPerIp.windowSeconds);
    const res = await loginReq(ip, { email: "x@y.test", password: "wrongpassword1" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
  });

  it("no x-forwarded-for => never limited (returns the normal 401 for bad creds)", async () => {
    const ip = "203.0.113.50";
    for (let i = 0; i < RL.loginPerIp.limit; i++) await checkRateLimit(rlKeys.login(ip), RL.loginPerIp.limit, RL.loginPerIp.windowSeconds);
    const res = await loginReq(null, { email: "x@y.test", password: "wrongpassword1" });
    expect(res.status).toBe(401);
  });

  it("a different IP is unaffected", async () => {
    const hot = "203.0.113.60";
    for (let i = 0; i < RL.loginPerIp.limit; i++) await checkRateLimit(rlKeys.login(hot), RL.loginPerIp.limit, RL.loginPerIp.windowSeconds);
    const res = await loginReq("203.0.113.61", { email: "x@y.test", password: "wrongpassword1" });
    expect(res.status).toBe(401);
  });
});

describe("register rate limiting", () => {
  it("429s once an IP exceeds the window", async () => {
    const ip = "203.0.113.70";
    for (let i = 0; i < RL.registerPerIp.limit; i++) await checkRateLimit(rlKeys.register(ip), RL.registerPerIp.limit, RL.registerPerIp.windowSeconds);
    const res = await register(new Request("http://x/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ restaurantName: "T", email: `${crypto.randomUUID()}@t.test`, password: "x".repeat(12) }),
    }));
    expect(res.status).toBe(429);
  });
});
