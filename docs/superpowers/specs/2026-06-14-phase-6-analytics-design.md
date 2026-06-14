# Phase 6 Design — Analytics (manager/owner dashboard data)

**Date:** 2026-06-14
**FRs:** FR-021 (per-trainee activity/comprehension), FR-022 (tenant-scoped, manager/owner-only
dashboard **data endpoints**), FR-023 (per-restaurant LLM/embedding usage + cost rollups)
**Depends on:** Phase 1 (auth/roles/RLS — `withTenant`, session/role guards), Phase 3
(`messages` / `message_sources` / `conversations` + `usage_events` written by `/api/ask`),
Phase 5 (`module_progress` — completions; RLS now on every data table).

---

## 1. Goal & FR map

A manager/owner reads **tenant-scoped analytics over data the app already records** — no new
writes, no migration. Two read endpoints: a tenant **summary** (usage, cost, grounding) and a
per-**trainee** activity roster. This is **API-only** (data endpoints), matching FR-022's wording
and every phase 1–5 being API-only; the React dashboard is deferred (Phase 8 demo).

| FR | Where it lands |
|---|---|
| FR-021 | `GET /api/analytics/trainees` — per-trainee questions asked (windowed) + modules completed (cumulative) |
| FR-022 | Both endpoints: `owner\|manager` only, tenant from session, `withTenant`-scoped |
| FR-023 | `GET /api/analytics/summary` → `cost` block — token + USD rollup by `kind` (embedding/completion), `$/answer` |

**Status quo:** all source data exists. `/api/ask` persists `messages` (user + assistant),
`message_sources` (**only when grounded** — see Decision 2), and `usage_events` (one `embedding`
event per ask; one `completion` event only when the LLM was actually called). `usage_events`
already carries the `(restaurant_id, created_at)` composite index the schema comment reserved
"for the Phase 6 time-windowed rollups." `module_progress` (Phase 5) has completion timestamps.
What's missing: only the read/aggregation layer.

**Not in this phase:** any new table/column/migration; React UI; deep retrieval-quality scoring
(FR-027, Phase 7/8 — we ship only a count-based grounding *rate* here).

## 2. Decisions locked in brainstorming

1. **API-only.** Tenant-scoped, manager/owner-only data endpoints (FR-022 literally says "data
   endpoints"). No frontend this phase — consistent with phases 1–5. UI → Phase 8 demo.
2. **Grounding signal = `message_sources` presence.** `src/lib/qa/answer.ts` writes source rows
   **only** for grounded answers (`grounded = passedGate && answerText !== FALLBACK_TEXT`; fallback
   inserts none). So an assistant message is **grounded ⟺ it has ≥1 `message_sources` row** — a
   structural signal, decoupled from the byte-exact `FALLBACK_TEXT` prompt string. Grounding rate
   is **count-based** (FR-021/022), not retrieval-quality scoring (FR-027, deferred).
3. **Bounded window enum** `?window=7d|30d|90d|all`, **default `30d`**. A Zod enum → trivial `400`
   on a bad value, and **no free-form date parsing** — deliberately sidestepping the invalid-`?cursor=`
   `500` house bug (Phase 7 still owns fixing that elsewhere). `window` is the **only** client input.
4. **Two endpoints, split by shape** (not one mega-endpoint): a fixed-shape aggregate (`/summary`)
   vs. a per-entity list (`/trainees`). Each gets its own clean Zod response contract; both
   `owner|manager`, both `withTenant`-scoped, both take `?window=`.
5. **Cost rollup = fixed `byKind` two-bucket** (`embedding` / `completion`), each bucket carrying a
   `model` label, not a dynamic `byModel` array. `usage_kind` is a **closed two-value enum**;
   embedding-vs-completion *is* this product's unit-economics story ($/answer at $49.99/mo). Honors
   "no speculative abstraction" — today there's one model per kind; the `byModel` array solves a
   problem (multiple models per kind) we don't have. **Upgrade trigger:** the first time two models
   run under one kind in a window, graduate to the array. (Edge: if a kind ever has >1 distinct
   model, its `model` label is reported `null` = "mixed", an honest signal rather than a fake pick.)
6. **Per-trainee semantics are intentionally mixed and documented:** `questionsAsked` is **windowed**
   (engagement in the selected period); `modulesCompleted` / `modulesTotal` / `lastActiveAt` are
   **cumulative/all-time** (standing curriculum progress — "4 of 6 done" and "last seen" are facts,
   not 30-day counts). Each field is the natural reading of its name; §4 states the windowing per field.

## 3. Architecture & flow

```
src/lib/analytics/window.ts     parseWindow(searchParams) → {window, since: Date|null, until: Date}; Zod enum
src/lib/analytics/queries.ts    summaryStats(tx, since) · traineeStats(tx, rid, since)  (tenant-scoped aggregates)
src/lib/analytics/serialize.ts  raw aggregate rows → response shapes (ISO dates, 6dp cost strings, null rates)
src/app/api/analytics/summary/route.ts    GET (owner|manager)
src/app/api/analytics/trainees/route.ts   GET (owner|manager)
test/lib/analytics-window.test.ts · test/lib/analytics-queries.test.ts (seeded DB) · test/api/analytics.test.ts
```

**Request flow** (identical skeleton for both routes):
```
route GET:
  session = requireSession(req)            -- none ⇒ 401
  role guard hasRole(role, "manager")      -- trainee ⇒ 403
  {window, since, until} = parseWindow(?window)   -- bad value ⇒ 400 (Zod enum)
  withTenant(rid):                         -- RLS scopes every data table; users filtered by rid explicitly
    rows = summaryStats(tx, since) | traineeStats(tx, rid, since)
  return 200 serialize(rows, {window, since, until})
```

**Tenancy.** `messages`, `message_sources`, `conversations`, `usage_events`, `module_progress`,
`modules` are all RLS-scoped inside `withTenant`. **`users` has no RLS**, so trainee counts/roster
filter `restaurant_id` explicitly (same idiom as the Phase 5 modules roster). No `restaurant_id`
ever comes from the client.

**Window.** `until = now`; `since = until − N days` for `7d/30d/90d`, `since = null` for `all`.
Aggregates apply `created_at >= since` (skipped when `since` is null). `since/until` are echoed in
the response `range` for display.

## 4. Metric definitions (exact semantics — where ambiguity hides)

All counts are tenant-scoped and, unless marked **cumulative**, restricted to `created_at` (or the
relevant timestamp) within the window.

### `GET /api/analytics/summary`

| Field | Definition |
|---|---|
| `questions.answered` | count of `messages` where `role='assistant'` in window (one per ask) |
| `questions.grounded` | assistant messages in window having **≥1 `message_sources` row** |
| `questions.fallback` | `answered − grounded` (assistant messages with no source rows) |
| `questions.groundingRate` | `grounded / answered` as a ratio in `[0,1]`; **`null` when `answered = 0`** |
| `trainees.total` | count of `users` with `role='trainee'` in the tenant (**cumulative** roster size) |
| `trainees.active` | distinct trainees with ≥1 **user** message in window **or** a `module_progress` row whose `started_at`/`completed_at` falls in window |
| `cost.byKind.{embedding,completion}` | per-kind rollup over `usage_events` in window: `{ model, calls, inputTokens, outputTokens, costUsd }`. `model` = the kind's single distinct model, or `null` if mixed. Empty ⇒ all-zero bucket, `model:null` |
| `cost.totalUsd` | `sum(cost_usd)` over all `usage_events` in window (= embedding + completion), 6dp string |
| `cost.perAnswerUsd` | `totalUsd / answered`, 6dp string; **`null` when `answered = 0`** |

> `questions.*` counts **all** askers (owner/manager can use `/api/ask` too) — it's a usage metric.
> The per-trainee endpoint is the trainee-only view.

### `GET /api/analytics/trainees`

One row per `role='trainee'` user in the tenant (including zero-activity trainees), ordered by
`questionsAsked` desc, then `email` asc.

| Field | Definition | Windowed? |
|---|---|---|
| `user` | `{ id, email }` | — |
| `questionsAsked` | count of `messages role='user'` in conversations owned by this trainee (`conversations.user_id`) | **windowed** |
| `modulesCompleted` | count of this user's `module_progress` rows with `status='completed'` | cumulative |
| `modulesTotal` | count of `modules` in the tenant (same denominator for every row) | cumulative |
| `lastActiveAt` | most recent of {their user-message `created_at`, their progress `started_at`/`completed_at`}; `null` if never active | cumulative |

(`messages` has no `user_id`; per-trainee question attribution joins `messages → conversations` on
`conversation_id` and groups by `conversations.user_id` = the asker who owns the thread.)

## 5. API contract

Inherits `docs/api.md`: error envelope, tenancy never a client input, success shapes. New §
`Analytics (/api/analytics)` promoted to FINAL.

| Route | Roles | Success |
|---|---|---|
| `GET /api/analytics/summary?window=` | owner\|manager | `200 {window, range, questions, trainees, cost}` |
| `GET /api/analytics/trainees?window=` | owner\|manager | `200 {window, range, trainees[]}` |

**`summary` response (camelCase):**
```jsonc
{
  "window": "30d",
  "range": { "since": "2026-05-15T…Z" | null, "until": "2026-06-14T…Z" },
  "questions": { "answered": 142, "grounded": 119, "fallback": 23, "groundingRate": 0.8380 },
  "trainees": { "total": 8, "active": 5 },
  "cost": {
    "totalUsd": "1.284300",
    "perAnswerUsd": "0.009044",
    "byKind": {
      "embedding":  { "model": "text-embedding-3-small", "calls": 142, "inputTokens": 2100,  "outputTokens": 0,    "costUsd": "0.065400" },
      "completion": { "model": "gpt-4.1-mini",            "calls": 119, "inputTokens": 81200, "outputTokens": 5300, "costUsd": "1.218900" }
    }
  }
}
```

**`trainees` response:**
```jsonc
{
  "window": "30d",
  "range": { "since": …, "until": … },
  "trainees": [
    { "user": { "id": "…", "email": "ana@…" },
      "questionsAsked": 31, "modulesCompleted": 4, "modulesTotal": 6, "lastActiveAt": "2026-06-13T…Z" }
  ]
}
```

**Input (Zod):** `window` ∈ `{7d,30d,90d,all}`, optional, default `30d`; unknown query params ignored
(not a body). Numbers are JSON numbers; `groundingRate` a ratio in `[0,1]` rounded to 4dp; all USD
values **strings** at 6dp (matching `numeric(12,6)` storage). `null` for `groundingRate`/`perAnswerUsd`
when there are no answers, and `lastActiveAt`/`byKind.*.model` when absent/mixed.

## 6. Error handling

| Failure | Behavior |
|---|---|
| Invalid `?window=` | `400 VALIDATION_ERROR` (Zod enum) — clean, no free-form date `500` |
| No session | `401 UNAUTHENTICATED` |
| Trainee role | `403 FORBIDDEN` (below manager) |
| Empty / brand-new tenant | `200` with zeros; `groundingRate`/`perAnswerUsd` `null`; both `byKind` buckets all-zero `model:null`; `trainees: []` |

No `404` surface (no `:id` params). No AI calls → no `502`. Read-only → no write/locking concerns.
Divide-by-zero guarded at every rate (`groundingRate`, `perAnswerUsd`).

## 7. Testing & Definition of Done

**vitest (Docker Postgres for DB/aggregation; OpenAI not involved), added to the current 134:**
- **`window.ts` (pure):** `7d/30d/90d` → correct `since` offset from a fixed `until`; `all` → `since=null`;
  invalid value → parse failure; default `30d` when absent.
- **`queries.ts` (seeded DB):** seed a tenant with a known mix — user+assistant messages, some grounded
  (with `message_sources`) some fallback (without); `usage_events` (embedding + completion at known
  costs); trainees with questions + `module_progress` (some completed). Assert `answered/grounded/
  fallback/groundingRate`, `cost.total/perAnswer/byKind` (tokens + USD), and trainee rows
  (`questionsAsked` windowed, `modulesCompleted` cumulative, `modulesTotal`, `lastActiveAt`, ordering).
- **Window filtering:** seed an out-of-window event/message → excluded under `7d`, included under `all`.
- **Grounding edge:** tenant with only fallbacks → `groundingRate = 0`; tenant with no answers →
  `groundingRate = null`, `perAnswerUsd = null`.
- **API (`test/api/analytics.test.ts`):** `401` anon · `403` trainee · `200` manager & owner · `400`
  bad `window` · **tenant isolation** (B's messages/usage/trainees invisible to A) · **empty-tenant**
  zeros/nulls · `trainees` excludes non-trainee users and includes zero-activity trainees.

**DoD:** `tsc --noEmit` clean · full vitest green · `next build` green · `docs/api.md` analytics
section FINAL · `CLAUDE.md` status updated (Phase 6 ✅, Phase 7 ◀). **No migration.** **Eval is not a
Phase 6 gate** (no retrieval/AI surface added) — `eval/` green by construction; one `eval:run`
no-regression sanity pass only, if a key is funded.

## 8. Out of scope (deferred)

- **React dashboard UI** — Phase 8 demo (all phases so far are API-only).
- **Free-form/custom date ranges** (`?from=&to=`) — bounded enum suffices for MVP.
- **Time-series / daily buckets / sparklines** — single-window aggregates only this phase.
- **Deep retrieval-quality metrics** (similarity distributions, top-k hit rate) — FR-027, Phase 7/8.
- **Per-trainee cost attribution** — `usage_events.user_id` exists, but FR-021 is activity, not spend.
- **Comprehension via quiz scores** — `module_progress.score` is reserved/unused (FR-020 deferred);
  "comprehension" here = modules completed.
- **Pagination on `/trainees`** — staff counts are tens; known door: add a cursor if that changes.
- **CSV/export, cross-tenant/platform analytics, conversation-content analysis.**

## 9. Open items carried to the plan

- **Grounding count query:** `EXISTS (SELECT 1 FROM message_sources … )` vs `LEFT JOIN … GROUP BY` —
  pick the simpler/correct form so each assistant message is counted once (no fan-out double-count).
- **`byKind` model label:** group `usage_events` by `kind`; derive `model` as the single distinct
  model for that kind else `null`. Confirm the one-query approach (e.g. `count(distinct model)`).
- **Numeric handling:** `pg` returns `numeric` as string — sum server-side (`sum(cost_usd)`) and pass
  through as 6dp strings; confirm token sums come back as JS numbers (int4) safely.
- **`active` trainee timestamps:** confirm the OR uses `messages.created_at` and
  `module_progress.started_at/completed_at` (the only activity signals).
- **`questionsAsked` join:** `messages → conversations` on `conversation_id`, group by
  `conversations.user_id`; verify a conversation's `user_id` is always the asker.
- **`groundingRate` rounding:** return raw ratio rounded to 4dp; frontend formats as %.
