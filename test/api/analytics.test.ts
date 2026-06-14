import { afterEach, describe, expect, it } from "vitest";
import { GET as SUMMARY } from "@/app/api/analytics/summary/route";
import { registerOwner, makeUserCookie } from "../helpers/auth";
import { seedChunk, seedAsk } from "../helpers/analytics";
import { cleanup } from "../helpers/db";

afterEach(cleanup);

const summary = (cookie: string | null, qs = "") =>
  SUMMARY(new Request(`http://x/api/analytics/summary${qs}`, { headers: cookie ? { cookie } : {} }));

describe("GET /api/analytics/summary", () => {
  it("401 anon; 403 trainee; 200 manager/owner", async () => {
    expect((await summary(null)).status).toBe(401);
    const { cookie, restaurant } = await registerOwner();
    const trainee = await makeUserCookie(restaurant.id, "trainee");
    expect((await summary(trainee.cookie)).status).toBe(403);
    const mgr = await makeUserCookie(restaurant.id, "manager");
    expect((await summary(mgr.cookie)).status).toBe(200);
    expect((await summary(cookie)).status).toBe(200);          // owner
  });

  it("400 on an invalid window", async () => {
    const { cookie } = await registerOwner();
    expect((await summary(cookie, "?window=year")).status).toBe(400);
  });

  it("rolls up the caller's tenant and isolates others", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    const chunk = await seedChunk(a.restaurant.id);
    await seedAsk({ rid: a.restaurant.id, userId: a.user.id, chunkId: chunk, grounded: true });
    await seedAsk({ rid: a.restaurant.id, userId: a.user.id, chunkId: chunk, grounded: false });
    // tenant B has its own activity that must NOT leak into A
    const chunkB = await seedChunk(b.restaurant.id);
    await seedAsk({ rid: b.restaurant.id, userId: b.user.id, chunkId: chunkB, grounded: true });

    const body = await (await summary(a.cookie, "?window=30d")).json();
    expect(body.questions).toEqual({ answered: 2, grounded: 1, fallback: 1, groundingRate: 0.5 });
    expect(body.cost.byKind.completion.calls).toBe(1);
    expect(body.cost.totalUsd).toBe("0.010040");              // 2*0.00002 + 1*0.01
  });

  it("empty tenant -> zeros and null rates", async () => {
    const { cookie } = await registerOwner();
    const body = await (await summary(cookie)).json();
    expect(body.questions).toEqual({ answered: 0, grounded: 0, fallback: 0, groundingRate: null });
    expect(body.cost.perAnswerUsd).toBeNull();
    expect(body.cost.byKind.embedding.model).toBeNull();
    expect(body.window).toBe("30d");                          // default
  });
});

import { GET as TRAINEES } from "@/app/api/analytics/trainees/route";

const trainees = (cookie: string | null, qs = "") =>
  TRAINEES(new Request(`http://x/api/analytics/trainees${qs}`, { headers: cookie ? { cookie } : {} }));

describe("GET /api/analytics/trainees", () => {
  it("401 anon; 403 trainee; 400 bad window", async () => {
    expect((await trainees(null)).status).toBe(401);
    const { cookie, restaurant } = await registerOwner();
    const t = await makeUserCookie(restaurant.id, "trainee");
    expect((await trainees(t.cookie)).status).toBe(403);
    expect((await trainees(cookie, "?window=decade")).status).toBe(400);
  });

  it("lists trainees only, ordered by questions, with cumulative completions", async () => {
    const a = await registerOwner();
    const chunk = await seedChunk(a.restaurant.id);
    const t1 = await makeUserCookie(a.restaurant.id, "trainee");
    await makeUserCookie(a.restaurant.id, "trainee"); // t2, no activity
    await seedAsk({ rid: a.restaurant.id, userId: t1.user.id, chunkId: chunk, grounded: true });
    await seedAsk({ rid: a.restaurant.id, userId: t1.user.id, chunkId: chunk, grounded: false });

    const body = await (await trainees(a.cookie, "?window=30d")).json();
    expect(body.trainees).toHaveLength(2);                    // both trainees, owner excluded
    expect(body.trainees[0].user.id).toBe(t1.user.id);
    expect(body.trainees[0].questionsAsked).toBe(2);
    expect(body.trainees[0].modulesTotal).toBe(0);           // no modules created
    expect(body.trainees[1].questionsAsked).toBe(0);
    expect(body.trainees[1].lastActiveAt).toBeNull();
  });

  it("isolates tenants", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    await makeUserCookie(b.restaurant.id, "trainee");         // B's trainee
    const body = await (await trainees(a.cookie)).json();
    expect(body.trainees).toHaveLength(0);                    // A has no trainees, sees none of B's
  });
});
