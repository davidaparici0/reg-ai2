# Phase 6 — Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two tenant-scoped, manager/owner-only analytics read endpoints — a usage/cost/grounding **summary** and a per-**trainee** activity roster — over data the app already records (no migration).

**Architecture:** Three focused libs (`window` parses the `?window=` enum → a time range; `queries` runs the tenant-scoped aggregates; `serialize` shapes rows into the JSON contract) behind two `GET` Route Handlers. Every aggregate runs inside `withTenant(rid, …)` so RLS scopes the data tables; `users` (no RLS) is filtered by `restaurant_id` explicitly. Read-only: no writes, no embeddings, no `/api/ask`, no `502`.

**Tech Stack:** Next.js 16 Route Handlers, Drizzle ORM + `pg` (raw `sql` for multi-aggregate GROUP BY), Zod, PostgreSQL 16 + RLS, vitest (Docker Postgres; OpenAI is NOT involved).

**Spec:** `docs/superpowers/specs/2026-06-14-phase-6-analytics-design.md`

**Conventions (apply to every task):**
- Commits append the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Implementation happens on a `phase-6-analytics` branch cut from `main` (the design commit already lives on `main`, per the Phase 5 pattern). The execution sub-skill creates it.
- Docker Postgres must be up (`docker compose up -d`); tests run serially (`vitest.config.ts` `fileParallelism:false`).

---

## File Structure

**Create:**
- `src/lib/analytics/window.ts` — `WindowParam` Zod enum + `parseWindow(searchParams, now)` → `{window, since, until}` | `null`.
- `src/lib/analytics/queries.ts` — `summaryStats(tx, rid, since)` + `traineeStats(tx, rid, since)`; the `SummaryStats`/`TraineeStats`/`CostBucket`/`TraineeRow` types.
- `src/lib/analytics/serialize.ts` — pure `serializeRange`, `toSummaryResponse`, `toTraineesResponse`.
- `src/app/api/analytics/summary/route.ts` — `GET`.
- `src/app/api/analytics/trainees/route.ts` — `GET`.
- `test/helpers/analytics.ts` — `seedChunk`, `seedAsk` (insert conversation/messages/sources/usage), reused by query + API tests.
- `test/lib/analytics-window.test.ts`, `test/lib/analytics-queries.test.ts`, `test/lib/analytics-serialize.test.ts`, `test/api/analytics.test.ts`.

**Modify:**
- `docs/api.md` — add §5 "Analytics" FINAL; renumber Deferred §5 → §6 and drop its Analytics row.
- `CLAUDE.md` — Phase 6 status.

**No migration.** All tables/columns/indexes already exist.

---

## Task 1: `window.ts` — parse the window enum into a time range

**Files:**
- Create: `src/lib/analytics/window.ts`
- Test: `test/lib/analytics-window.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/lib/analytics-window.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseWindow } from "@/lib/analytics/window";

const NOW = new Date("2026-06-14T00:00:00.000Z");
const sp = (qs: string) => new URLSearchParams(qs);
const DAY = 24 * 60 * 60 * 1000;

describe("parseWindow", () => {
  it("defaults to 30d when absent", () => {
    const w = parseWindow(sp(""), NOW)!;
    expect(w.window).toBe("30d");
    expect(w.until).toEqual(NOW);
    expect(w.since).toEqual(new Date(NOW.getTime() - 30 * DAY));
  });
  it("computes 7d and 90d offsets", () => {
    expect(parseWindow(sp("window=7d"), NOW)!.since).toEqual(new Date(NOW.getTime() - 7 * DAY));
    expect(parseWindow(sp("window=90d"), NOW)!.since).toEqual(new Date(NOW.getTime() - 90 * DAY));
  });
  it("maps 'all' to a null since (no lower bound)", () => {
    const w = parseWindow(sp("window=all"), NOW)!;
    expect(w.window).toBe("all");
    expect(w.since).toBeNull();
    expect(w.until).toEqual(NOW);
  });
  it("returns null for an invalid window value", () => {
    expect(parseWindow(sp("window=bogus"), NOW)).toBeNull();
    expect(parseWindow(sp("window=1y"), NOW)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- analytics-window`
Expected: FAIL — cannot resolve `@/lib/analytics/window`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/analytics/window.ts`:

```ts
// Parse the ?window= selector into a concrete [since, until] range. A bounded Zod enum
// (not free-form dates) => an invalid value is a clean 400, and there is no date parsing
// to 500 on. `now` is injected so the logic is deterministic in tests.
import { z } from "zod";

export const WindowParam = z.enum(["7d", "30d", "90d", "all"]).default("30d");
export type Window = z.infer<typeof WindowParam>;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS: Record<Exclude<Window, "all">, number> = { "7d": 7, "30d": 30, "90d": 90 };

export type WindowRange = { window: Window; since: Date | null; until: Date };

export function parseWindow(searchParams: URLSearchParams, now: Date): WindowRange | null {
  const parsed = WindowParam.safeParse(searchParams.get("window") ?? undefined);
  if (!parsed.success) return null;
  const window = parsed.data;
  if (window === "all") return { window, since: null, until: now };
  return { window, since: new Date(now.getTime() - DAYS[window] * DAY_MS), until: now };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- analytics-window`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/analytics/window.ts test/lib/analytics-window.test.ts
git commit -m "Phase 6: window enum -> time range parser (FR-022)"
```

---

## Task 2: `queries.ts` — tenant-scoped aggregates (+ seed helper)

**Files:**
- Create: `test/helpers/analytics.ts`
- Create: `src/lib/analytics/queries.ts`
- Test: `test/lib/analytics-queries.test.ts`

- [ ] **Step 1: Write the seed helper**

Create `test/helpers/analytics.ts`:

```ts
// Seeds the rows /api/ask would write, WITHOUT calling OpenAI. message_sources requires a real
// chunk (FK), so seedChunk makes one document+chunk per tenant to anchor grounded answers.
import { db, withTenant } from "@/lib/db";
import {
  conversations, messages, messageSources, documents, chunks, usageEvents,
} from "@/db/schema";

const ZERO_VEC = Array(1536).fill(0);

export async function seedChunk(rid: string): Promise<string> {
  return withTenant(rid, async (tx) => {
    const [doc] = await tx.insert(documents).values({
      restaurantId: rid, title: "SOP", sourceType: "text", contentHash: crypto.randomUUID(), status: "done",
    }).returning();
    const [chunk] = await tx.insert(chunks).values({
      documentId: doc.id, restaurantId: rid, chunkIndex: 0, text: "x", tokenCount: 1, embedding: ZERO_VEC,
    }).returning();
    return chunk.id;
  });
}

// One Q&A: conversation (owned by userId) + user msg + assistant msg, all at createdAt.
// grounded=true also writes a message_sources row (=> counted grounded) and a completion usage event.
// Every ask writes one embedding usage event (mirrors the real pipeline).
export async function seedAsk(opts: {
  rid: string; userId: string; chunkId: string; grounded: boolean; createdAt?: Date;
}): Promise<string> {
  const { rid, userId, chunkId, grounded } = opts;
  const createdAt = opts.createdAt ?? new Date();
  return withTenant(rid, async (tx) => {
    const [conv] = await tx.insert(conversations).values({ restaurantId: rid, userId }).returning();
    await tx.insert(messages).values({ conversationId: conv.id, restaurantId: rid, role: "user", content: "q", createdAt });
    const [a] = await tx.insert(messages).values({
      conversationId: conv.id, restaurantId: rid, role: "assistant", content: grounded ? "answer" : "fallback", createdAt,
    }).returning();
    if (grounded) {
      await tx.insert(messageSources).values({ messageId: a.id, chunkId, restaurantId: rid, similarity: 0.7 });
    }
    await tx.insert(usageEvents).values({
      restaurantId: rid, userId, kind: "embedding", model: "text-embedding-3-small",
      inputTokens: 10, outputTokens: 0, costUsd: "0.000020", createdAt,
    });
    if (grounded) {
      await tx.insert(usageEvents).values({
        restaurantId: rid, userId, kind: "completion", model: "gpt-4.1-mini",
        inputTokens: 100, outputTokens: 20, costUsd: "0.010000", createdAt,
      });
    }
    return a.id;
  });
}
```

(Confirmed columns: `chunks` needs `documentId, restaurantId, chunkIndex, text, tokenCount, embedding`; `messages` needs `conversationId, restaurantId, role, content` and accepts an explicit `createdAt`; `usageEvents` `costUsd` is a `numeric` string.)

- [ ] **Step 2: Write the failing test**

Create `test/lib/analytics-queries.test.ts`:

```ts
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
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npm test -- analytics-queries`
Expected: FAIL — cannot resolve `@/lib/analytics/queries`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/analytics/queries.ts`:

```ts
// Tenant-scoped analytics aggregates. Raw `sql` is used for the multi-aggregate GROUP BYs
// (clearer + one round-trip each than the query builder). Every query runs inside withTenant,
// so messages/message_sources/usage_events/conversations/module_progress/modules are RLS-scoped;
// `users` has NO RLS, so trainee queries filter restaurant_id explicitly (::uuid bind).
// `since` is a Date for a bounded window, or null for "all" (the IS NULL branch drops the filter).
import { sql } from "drizzle-orm";
import type { Tx } from "@/lib/db";

export type CostBucket = { model: string | null; calls: number; inputTokens: number; outputTokens: number; costUsd: string };
export type SummaryStats = {
  answered: number; grounded: number; traineesTotal: number; traineesActive: number;
  totalCostUsd: string; cost: { embedding: CostBucket; completion: CostBucket };
};
export type TraineeRow = { userId: string; email: string; questionsAsked: number; modulesCompleted: number; lastActiveAt: Date | null };
export type TraineeStats = { modulesTotal: number; rows: TraineeRow[] };

const ZERO_BUCKET: CostBucket = { model: null, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: "0.000000" };

function money(raw: unknown): string {
  return Number(raw ?? 0).toFixed(6);
}

export async function summaryStats(tx: Tx, rid: string, since: Date | null): Promise<SummaryStats> {
  // 1. answered + grounded (assistant messages; grounded = has >=1 message_sources row)
  const q = (await tx.execute(sql`
    SELECT
      count(*) FILTER (WHERE m.role = 'assistant')::int AS answered,
      count(*) FILTER (WHERE m.role = 'assistant'
        AND EXISTS (SELECT 1 FROM message_sources s WHERE s.message_id = m.id))::int AS grounded
    FROM messages m
    WHERE (${since}::timestamptz IS NULL OR m.created_at >= ${since})
  `)).rows[0] as { answered: number; grounded: number };

  // 2. cost by kind (+ model is the single distinct model for the kind, else null = mixed)
  const kinds = (await tx.execute(sql`
    SELECT kind,
      CASE WHEN count(DISTINCT model) = 1 THEN max(model) ELSE NULL END AS model,
      count(*)::int AS calls,
      COALESCE(sum(input_tokens), 0)::int AS input_tokens,
      COALESCE(sum(output_tokens), 0)::int AS output_tokens,
      COALESCE(sum(cost_usd), 0)::text AS cost_usd
    FROM usage_events
    WHERE (${since}::timestamptz IS NULL OR created_at >= ${since})
    GROUP BY kind
  `)).rows as Array<{ kind: "embedding" | "completion"; model: string | null; calls: number; input_tokens: number; output_tokens: number; cost_usd: string }>;

  const bucketFor = (kind: "embedding" | "completion"): CostBucket => {
    const row = kinds.find((k) => k.kind === kind);
    if (!row) return { ...ZERO_BUCKET };
    return { model: row.model, calls: row.calls, inputTokens: row.input_tokens, outputTokens: row.output_tokens, costUsd: money(row.cost_usd) };
  };

  // 3. total cost (all kinds), one SQL sum so money math stays in the DB
  const totalRow = (await tx.execute(sql`
    SELECT COALESCE(sum(cost_usd), 0)::text AS total
    FROM usage_events
    WHERE (${since}::timestamptz IS NULL OR created_at >= ${since})
  `)).rows[0] as { total: string };

  // 4. trainee roster size + active count (active = a question OR progress event in window)
  const tr = (await tx.execute(sql`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE active)::int AS active
    FROM (
      SELECT
        EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
                WHERE c.user_id = u.id AND m.role = 'user'
                  AND (${since}::timestamptz IS NULL OR m.created_at >= ${since}))
        OR EXISTS (SELECT 1 FROM module_progress mp WHERE mp.user_id = u.id
                  AND (${since}::timestamptz IS NULL OR mp.started_at >= ${since} OR mp.completed_at >= ${since})) AS active
      FROM users u
      WHERE u.restaurant_id = ${rid}::uuid AND u.role = 'trainee'
    ) z
  `)).rows[0] as { total: number; active: number };

  return {
    answered: q.answered, grounded: q.grounded,
    traineesTotal: tr.total, traineesActive: tr.active,
    totalCostUsd: money(totalRow.total),
    cost: { embedding: bucketFor("embedding"), completion: bucketFor("completion") },
  };
}

export async function traineeStats(tx: Tx, rid: string, since: Date | null): Promise<TraineeStats> {
  const total = (await tx.execute(sql`SELECT count(*)::int AS n FROM modules`)).rows[0] as { n: number };

  // questionsAsked = windowed user messages owned by the trainee (via conversations.user_id).
  // lastActiveAt   = cumulative max over {their user messages, their progress timestamps}.
  // modulesCompleted = cumulative count of status='completed'.
  const rows = (await tx.execute(sql`
    SELECT
      u.id AS user_id, u.email AS email,
      COALESCE(q.questions_asked, 0)::int AS questions_asked,
      COALESCE(mp.modules_completed, 0)::int AS modules_completed,
      GREATEST(lm.last_msg, mp.last_progress) AS last_active_at
    FROM users u
    LEFT JOIN (
      SELECT c.user_id, count(*)::int AS questions_asked
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.role = 'user' AND (${since}::timestamptz IS NULL OR m.created_at >= ${since})
      GROUP BY c.user_id
    ) q ON q.user_id = u.id
    LEFT JOIN (
      SELECT c.user_id, max(m.created_at) AS last_msg
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.role = 'user'
      GROUP BY c.user_id
    ) lm ON lm.user_id = u.id
    LEFT JOIN (
      SELECT user_id, count(*) FILTER (WHERE status = 'completed')::int AS modules_completed,
             max(GREATEST(started_at, completed_at)) AS last_progress
      FROM module_progress
      GROUP BY user_id
    ) mp ON mp.user_id = u.id
    WHERE u.restaurant_id = ${rid}::uuid AND u.role = 'trainee'
    ORDER BY COALESCE(q.questions_asked, 0) DESC, u.email ASC
  `)).rows as Array<{ user_id: string; email: string; questions_asked: number; modules_completed: number; last_active_at: Date | null }>;

  return {
    modulesTotal: total.n,
    rows: rows.map((r) => ({
      userId: r.user_id, email: r.email,
      questionsAsked: r.questions_asked, modulesCompleted: r.modules_completed,
      lastActiveAt: r.last_active_at,
    })),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- analytics-queries`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/analytics/queries.ts test/helpers/analytics.ts test/lib/analytics-queries.test.ts
git commit -m "Phase 6: analytics aggregate queries + seed helper (FR-021/FR-023)"
```

---

## Task 3: `serialize.ts` — shape rows into the JSON contract

**Files:**
- Create: `src/lib/analytics/serialize.ts`
- Test: `test/lib/analytics-serialize.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/lib/analytics-serialize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { serializeRange, toSummaryResponse, toTraineesResponse } from "@/lib/analytics/serialize";
import type { SummaryStats, TraineeStats } from "@/lib/analytics/queries";

const range = serializeRange(new Date("2026-05-15T00:00:00Z"), new Date("2026-06-14T00:00:00Z"));

const stats: SummaryStats = {
  answered: 5, grounded: 3, traineesTotal: 2, traineesActive: 1, totalCostUsd: "0.030100",
  cost: {
    embedding: { model: "text-embedding-3-small", calls: 5, inputTokens: 50, outputTokens: 0, costUsd: "0.000100" },
    completion: { model: "gpt-4.1-mini", calls: 3, inputTokens: 300, outputTokens: 60, costUsd: "0.030000" },
  },
};

describe("serializeRange", () => {
  it("emits ISO strings and a null since for 'all'", () => {
    expect(range).toEqual({ since: "2026-05-15T00:00:00.000Z", until: "2026-06-14T00:00:00.000Z" });
    expect(serializeRange(null, new Date("2026-06-14T00:00:00Z")).since).toBeNull();
  });
});

describe("toSummaryResponse", () => {
  it("derives fallback, groundingRate, and perAnswerUsd", () => {
    const out = toSummaryResponse("30d", range, stats);
    expect(out.questions).toEqual({ answered: 5, grounded: 3, fallback: 2, groundingRate: 0.6 });
    expect(out.trainees).toEqual({ total: 2, active: 1 });
    expect(out.cost.totalUsd).toBe("0.030100");
    expect(out.cost.perAnswerUsd).toBe("0.006020");                 // 0.0301 / 5
    expect(out.cost.byKind.completion.costUsd).toBe("0.030000");
    expect(out.window).toBe("30d");
  });
  it("nulls the rates when there are no answers", () => {
    const empty: SummaryStats = {
      answered: 0, grounded: 0, traineesTotal: 0, traineesActive: 0, totalCostUsd: "0.000000",
      cost: { embedding: { model: null, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: "0.000000" },
              completion: { model: null, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: "0.000000" } },
    };
    const out = toSummaryResponse("all", serializeRange(null, new Date("2026-06-14T00:00:00Z")), empty);
    expect(out.questions.groundingRate).toBeNull();
    expect(out.cost.perAnswerUsd).toBeNull();
  });
});

describe("toTraineesResponse", () => {
  it("maps rows and ISO-formats lastActiveAt (null stays null)", () => {
    const ts: TraineeStats = { modulesTotal: 3, rows: [
      { userId: "u1", email: "a@x", questionsAsked: 2, modulesCompleted: 2, lastActiveAt: new Date("2026-06-13T00:00:00Z") },
      { userId: "u2", email: "b@x", questionsAsked: 0, modulesCompleted: 0, lastActiveAt: null },
    ] };
    const out = toTraineesResponse("30d", range, ts);
    expect(out.trainees[0]).toEqual({ user: { id: "u1", email: "a@x" }, questionsAsked: 2, modulesCompleted: 2, modulesTotal: 3, lastActiveAt: "2026-06-13T00:00:00.000Z" });
    expect(out.trainees[1].lastActiveAt).toBeNull();
    expect(out.trainees[1].modulesTotal).toBe(3);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- analytics-serialize`
Expected: FAIL — cannot resolve `@/lib/analytics/serialize`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/analytics/serialize.ts`:

```ts
// Pure shaping of query results into the API JSON. All money is a 6dp string (matches
// numeric(12,6) storage); groundingRate is a [0,1] ratio (4dp) or null; perAnswerUsd is
// null when there were no answers. No DB access here — trivially unit-testable.
import type { Window } from "@/lib/analytics/window";
import type { SummaryStats, TraineeStats, CostBucket } from "@/lib/analytics/queries";

export type Range = { since: string | null; until: string };

export function serializeRange(since: Date | null, until: Date): Range {
  return { since: since ? since.toISOString() : null, until: until.toISOString() };
}

function bucket(b: CostBucket) {
  return { model: b.model, calls: b.calls, inputTokens: b.inputTokens, outputTokens: b.outputTokens, costUsd: b.costUsd };
}

export function toSummaryResponse(window: Window, range: Range, s: SummaryStats) {
  const total = Number(s.totalCostUsd);
  return {
    window, range,
    questions: {
      answered: s.answered,
      grounded: s.grounded,
      fallback: s.answered - s.grounded,
      groundingRate: s.answered > 0 ? Number((s.grounded / s.answered).toFixed(4)) : null,
    },
    trainees: { total: s.traineesTotal, active: s.traineesActive },
    cost: {
      totalUsd: total.toFixed(6),
      perAnswerUsd: s.answered > 0 ? (total / s.answered).toFixed(6) : null,
      byKind: { embedding: bucket(s.cost.embedding), completion: bucket(s.cost.completion) },
    },
  };
}

export function toTraineesResponse(window: Window, range: Range, t: TraineeStats) {
  return {
    window, range,
    trainees: t.rows.map((r) => ({
      user: { id: r.userId, email: r.email },
      questionsAsked: r.questionsAsked,
      modulesCompleted: r.modulesCompleted,
      modulesTotal: t.modulesTotal,
      lastActiveAt: r.lastActiveAt ? r.lastActiveAt.toISOString() : null,
    })),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- analytics-serialize`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/analytics/serialize.ts test/lib/analytics-serialize.test.ts
git commit -m "Phase 6: analytics response serialization (derived rates, 6dp cost strings)"
```

---

## Task 4: `GET /api/analytics/summary`

**Files:**
- Create: `src/app/api/analytics/summary/route.ts`
- Test: `test/api/analytics.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/api/analytics.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- test/api/analytics`
Expected: FAIL — cannot resolve `@/app/api/analytics/summary/route`.

- [ ] **Step 3: Write the implementation**

Create `src/app/api/analytics/summary/route.ts`:

```ts
// GET tenant analytics summary (FR-022/FR-023) — owner|manager, tenant from session.
// Read-only: aggregates messages/message_sources/usage_events/module_progress under withTenant.
import { NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { requireSession, hasRole } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { parseWindow } from "@/lib/analytics/window";
import { summaryStats } from "@/lib/analytics/queries";
import { serializeRange, toSummaryResponse } from "@/lib/analytics/serialize";

export async function GET(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");

  const w = parseWindow(new URL(req.url).searchParams, new Date());
  if (!w) return errorResponse("VALIDATION_ERROR", "Invalid window (use 7d, 30d, 90d, or all)");

  const rid = session.restaurant.id;
  const stats = await withTenant(rid, (tx) => summaryStats(tx, rid, w.since));
  return NextResponse.json(toSummaryResponse(w.window, serializeRange(w.since, w.until), stats));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/api/analytics`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/analytics/summary/route.ts test/api/analytics.test.ts
git commit -m "Phase 6: GET /api/analytics/summary — usage/cost/grounding rollup (FR-022/FR-023)"
```

---

## Task 5: `GET /api/analytics/trainees`

**Files:**
- Create: `src/app/api/analytics/trainees/route.ts`
- Test: append to `test/api/analytics.test.ts`

- [ ] **Step 1: Write the failing test (append)**

Append to `test/api/analytics.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- test/api/analytics`
Expected: FAIL — cannot resolve `@/app/api/analytics/trainees/route`.

- [ ] **Step 3: Write the implementation**

Create `src/app/api/analytics/trainees/route.ts`:

```ts
// GET per-trainee activity roster (FR-021) — owner|manager, tenant from session.
// users has no RLS, so traineeStats filters restaurant_id explicitly; message/progress data is RLS-scoped.
import { NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { requireSession, hasRole } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { parseWindow } from "@/lib/analytics/window";
import { traineeStats } from "@/lib/analytics/queries";
import { serializeRange, toTraineesResponse } from "@/lib/analytics/serialize";

export async function GET(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");

  const w = parseWindow(new URL(req.url).searchParams, new Date());
  if (!w) return errorResponse("VALIDATION_ERROR", "Invalid window (use 7d, 30d, 90d, or all)");

  const rid = session.restaurant.id;
  const stats = await withTenant(rid, (tx) => traineeStats(tx, rid, w.since));
  return NextResponse.json(toTraineesResponse(w.window, serializeRange(w.since, w.until), stats));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/api/analytics`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/analytics/trainees/route.ts test/api/analytics.test.ts
git commit -m "Phase 6: GET /api/analytics/trainees — per-trainee activity roster (FR-021)"
```

---

## Task 6: Docs + full verification

**Files:**
- Modify: `docs/api.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Promote `docs/api.md` to a FINAL Analytics section**

In `docs/api.md`, the current `## 5. Deferred …` becomes `## 6.`, and a new §5 is inserted before it. Replace the `## 5. Deferred — defined at the start of their phase (not now)` heading and its table with:

```markdown
## 5. Analytics (`/api/analytics`) — Phase 6, FINAL

Tenant-scoped, **owner|manager-only** read endpoints over data the app already records (no new
writes, no migration). Time range via a bounded `?window=7d|30d|90d|all` enum (default `30d`).

| Route | Roles | Success |
|---|---|---|
| `GET /api/analytics/summary?window=` | owner\|manager | `200 {window, range, questions, trainees, cost}` |
| `GET /api/analytics/trainees?window=` | owner\|manager | `200 {window, range, trainees[]}` |

`summary`: `questions {answered, grounded, fallback, groundingRate}` (grounded = assistant message
has ≥1 `message_sources` row; `groundingRate` null when answered=0) · `trainees {total, active}` ·
`cost {totalUsd, perAnswerUsd, byKind:{embedding, completion}}` — each bucket `{model, calls,
inputTokens, outputTokens, costUsd}`, all USD as 6dp strings, `model` null if a kind ever has >1
model. `trainees`: per `role='trainee'` user — `questionsAsked` (windowed), `modulesCompleted` /
`modulesTotal` / `lastActiveAt` (cumulative), ordered by `questionsAsked` desc.

Errors: `400` invalid `window` · `401` · `403` (below manager). No `:id` ⇒ no `404`; read-only ⇒ no `502`.

## 6. Deferred — defined at the start of their phase (not now)
```

Then delete the Analytics row from that (now §6) Deferred table, leaving only the streaming row.

- [ ] **Step 2: Update `CLAUDE.md`**

In "Build phases", change Phase 6 to `✅ DONE` and Phase 7 to `◀ CURRENT`:

```
- **Phase 6 — Analytics dashboard.** ✅ DONE. FR-021–023.
- **Phase 7 — Guardrails, cost controls, hardening.** ◀ CURRENT. FR-026–027, injection resistance.
```

In "Current status", replace the `**Next step → Phase 6 …**` paragraph with a `**Phase 6 — COMPLETE.**`
block (mirror the Phase 5 block): API-only analytics; two endpoints (`/summary`, `/trainees`),
owner|manager, `?window=` enum; grounding rate from `message_sources` presence; `cost.byKind`
two-bucket; per-trainee windowed questions + cumulative completions; **no migration**; the new test
count; then a `**Next step → Phase 7 …**` line.

- [ ] **Step 3: Full type + test + build verification**

Run each and confirm:
- `npx tsc --noEmit` → clean
- `npm test` → all green (134 prior + the new analytics tests)
- `npm run build` → green (new routes `/api/analytics/summary`, `/api/analytics/trainees` listed)

- [ ] **Step 4: Eval no-regression sanity (not a gate)**

Phase 6 adds no retrieval/AI surface, so the eval set is unaffected. With a funded `OPENAI_API_KEY`:
`npm run eval:seed && npm run eval:run` → all four gates still PASS. (Skip if no key; explicitly not a Phase 6 gate.)

- [ ] **Step 5: Commit**

```bash
git add docs/api.md CLAUDE.md
git commit -m "Phase 6 complete: analytics endpoints (FR-021-023); summary + trainee rollups"
```

---

## Self-Review checklist (run before handing off to execution)

- **Spec coverage:** FR-021 → Tasks 2/5 (traineeStats, `/trainees`) ✓ · FR-022 → Tasks 1/4/5 (window, both endpoints, role guard) ✓ · FR-023 → Tasks 2/3/4 (cost byKind, serialize, `/summary`) ✓ · grounding rate → Tasks 2/3 (message_sources EXISTS, derived rate) ✓ · api.md §5 + CLAUDE.md → Task 6 ✓. **No migration** (spec §1) — confirmed, no schema task.
- **Type consistency:** `parseWindow→WindowRange{window,since,until}`, `summaryStats(tx,rid,since)→SummaryStats`, `traineeStats(tx,rid,since)→TraineeStats`, `CostBucket`, `TraineeRow`, `serializeRange`/`toSummaryResponse`/`toTraineesResponse` — names/signatures match across Tasks 1–5.
- **Grounding signal:** `message_sources` presence (verified in spec §2 against `src/lib/qa/answer.ts`); seed helper writes a source row only when `grounded`.
- **Tenancy:** every aggregate inside `withTenant`; `users` filtered by `restaurant_id::uuid` (no RLS); isolation asserted in Tasks 4/5.
- **Money math in SQL** (`sum(cost_usd)`), JS only formats (`toFixed(6)`); rates guarded against divide-by-zero.
- **No placeholders:** every step has concrete code/commands/expected output.

> If executing in a worktree, it should have been created via `superpowers:using-git-worktrees` at execution start.
```

