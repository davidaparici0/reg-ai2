import { afterEach, describe, expect, it } from "vitest";
import { db, withTenant } from "@/lib/db";
import { restaurants, users, modules, moduleProgress } from "@/db/schema";
import { summaryStats, traineeStats } from "@/lib/analytics/queries";
import { seedChunk, seedAsk } from "../helpers/analytics";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);
const DAY = 24 * 60 * 60 * 1000;

async function trainee(rid: string) {
  const [u] = await db.insert(users).values({
    restaurantId: rid, email: `${crypto.randomUUID()}@t.test`, passwordHash: "x", role: "trainee",
  }).returning();
  return u;
}

describe("summaryStats", () => {
  it("rolls up answered/grounded, trainees, and cost by kind within the window", async () => {
    const [r] = await db.insert(restaurants).values({ name: "SumA" }).returning();
    track(r.id);
    const t = await trainee(r.id);
    await trainee(r.id); // a second trainee, never active
    const chunk = await seedChunk(r.id);
    // 3 grounded + 2 fallback, all "now"
    for (let i = 0; i < 3; i++) await seedAsk({ rid: r.id, userId: t.id, chunkId: chunk, grounded: true });
    for (let i = 0; i < 2; i++) await seedAsk({ rid: r.id, userId: t.id, chunkId: chunk, grounded: false });
    // 1 grounded answer 100 days ago — outside a 30d window
    await seedAsk({ rid: r.id, userId: t.id, chunkId: chunk, grounded: true, createdAt: new Date(Date.now() - 100 * DAY) });

    const since30 = new Date(Date.now() - 30 * DAY);
    const s = await withTenant(r.id, (tx) => summaryStats(tx, r.id, since30));
    expect(s.answered).toBe(5);
    expect(s.grounded).toBe(3);
    expect(s.traineesTotal).toBe(2);
    expect(s.traineesActive).toBe(1);
    expect(s.totalCostUsd).toBe("0.030100");                 // 5*0.00002 + 3*0.01
    expect(s.cost.embedding).toEqual({ model: "text-embedding-3-small", calls: 5, inputTokens: 50, outputTokens: 0, costUsd: "0.000100" });
    expect(s.cost.completion).toEqual({ model: "gpt-4.1-mini", calls: 3, inputTokens: 300, outputTokens: 60, costUsd: "0.030000" });

    const all = await withTenant(r.id, (tx) => summaryStats(tx, r.id, null));
    expect(all.answered).toBe(6);                            // window=all includes the old one
    expect(all.grounded).toBe(4);
  });

  it("returns zeros and null-able model on an empty tenant", async () => {
    const [r] = await db.insert(restaurants).values({ name: "SumEmpty" }).returning();
    track(r.id);
    const s = await withTenant(r.id, (tx) => summaryStats(tx, r.id, null));
    expect(s).toMatchObject({ answered: 0, grounded: 0, traineesTotal: 0, traineesActive: 0, totalCostUsd: "0.000000" });
    expect(s.cost.embedding).toEqual({ model: null, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: "0.000000" });
  });
});

describe("traineeStats", () => {
  it("lists trainees with windowed questions, cumulative completions, ordered by activity", async () => {
    const [r] = await db.insert(restaurants).values({ name: "TrA" }).returning();
    track(r.id);
    const t1 = await trainee(r.id);
    const t2 = await trainee(r.id); // zero activity
    const chunk = await seedChunk(r.id);
    await seedAsk({ rid: r.id, userId: t1.id, chunkId: chunk, grounded: true });
    await seedAsk({ rid: r.id, userId: t1.id, chunkId: chunk, grounded: false });
    // 3 modules, t1 completed 2 (cumulative — no window)
    const mods = await withTenant(r.id, (tx) => tx.insert(modules).values([
      { restaurantId: r.id, title: "M0", content: { body: "b" }, position: 0 },
      { restaurantId: r.id, title: "M1", content: { body: "b" }, position: 1 },
      { restaurantId: r.id, title: "M2", content: { body: "b" }, position: 2 },
    ]).returning());
    await withTenant(r.id, (tx) => tx.insert(moduleProgress).values([
      { restaurantId: r.id, moduleId: mods[0].id, userId: t1.id, status: "completed", completedAt: new Date() },
      { restaurantId: r.id, moduleId: mods[1].id, userId: t1.id, status: "completed", completedAt: new Date() },
    ]));

    const stats = await withTenant(r.id, (tx) => traineeStats(tx, r.id, new Date(Date.now() - 30 * DAY)));
    expect(stats.modulesTotal).toBe(3);
    expect(stats.rows).toHaveLength(2);
    const [first, second] = stats.rows;                       // ordered by questionsAsked desc
    expect(first.userId).toBe(t1.id);
    expect(first.questionsAsked).toBe(2);
    expect(first.modulesCompleted).toBe(2);
    expect(first.lastActiveAt).toBeInstanceOf(Date);
    expect(second.userId).toBe(t2.id);
    expect(second.questionsAsked).toBe(0);
    expect(second.modulesCompleted).toBe(0);
    expect(second.lastActiveAt).toBeNull();
  });
});
