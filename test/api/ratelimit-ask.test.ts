import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { POST as ask } from "@/app/api/ask/route";
import { checkRateLimit } from "@/lib/ratelimit/limiter";
import { RL, rlKeys } from "@/lib/ratelimit/config";
import { registerOwner } from "../helpers/auth";
import { cleanup } from "../helpers/db";

afterEach(cleanup);
afterEach(async () => { await db.execute(sql`DELETE FROM rate_limits WHERE key LIKE 'ask:%'`); });

const askReq = (cookie: string | null, body: unknown) =>
  ask(new Request("http://x/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }));

describe("ask rate limiting (429 before any OpenAI call)", () => {
  it("401 for anon (limiter never reached)", async () => {
    expect((await askReq(null, { question: "hi" })).status).toBe(401);
  });

  it("429 when the per-minute cap is exceeded", async () => {
    const { cookie, restaurant } = await registerOwner();
    for (let i = 0; i < RL.askPerMinute.limit; i++) await checkRateLimit(rlKeys.askMin(restaurant.id), RL.askPerMinute.limit, RL.askPerMinute.windowSeconds);
    const res = await askReq(cookie, { question: "what wine pairs with short rib?" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
  });

  it("429 when the per-day cap is exceeded (minute ok)", async () => {
    const { cookie, restaurant } = await registerOwner();
    for (let i = 0; i < RL.askPerDay.limit; i++) await checkRateLimit(rlKeys.askDay(restaurant.id), RL.askPerDay.limit, RL.askPerDay.windowSeconds);
    const res = await askReq(cookie, { question: "what wine pairs with short rib?" });
    expect(res.status).toBe(429);
  });

  it("one tenant hitting its cap does not limit another", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    for (let i = 0; i < RL.askPerMinute.limit; i++) await checkRateLimit(rlKeys.askMin(a.restaurant.id), RL.askPerMinute.limit, RL.askPerMinute.windowSeconds);
    const rb = await checkRateLimit(rlKeys.askMin(b.restaurant.id), RL.askPerMinute.limit, RL.askPerMinute.windowSeconds);
    expect(rb.count).toBe(1);
    expect(rb.ok).toBe(true);
  });
});
