# Phase 5 Design — Training Modules + Progress

**Date:** 2026-06-14
**FRs:** FR-018 (module CRUD, ordered, optionally tied to docs/menu items),
FR-019 (per-trainee progress: started/completed/score), FR-020 (adaptive next-step — **Stretch, deferred**)
**Depends on:** Phase 1 (auth/roles/RLS — `modules` policy live since migration 0001; `withTenant`,
session/role guards), Phase 2 (`documents` table — ref linkage target), Phase 4 (`menu_items` table —
ref linkage target; the `/api/menu-items` route/validation/cursor idioms this phase mirrors).

---

## 1. Goal & FR map

A manager builds an **ordered curriculum** of training modules (authored body text, optionally tied
to uploaded documents and menu items). A trainee reads a module and **self-marks** progress
(in_progress → completed). Managers can see a **roster** of who has/hasn't completed a module. This
phase also closes the last RLS gap by protecting `module_progress`.

| FR | Where it lands |
|---|---|
| FR-018 | `POST/GET /api/modules`, `GET/PATCH/DELETE /api/modules/:id`; ordered via `modules.position`; refs in `content` |
| FR-019 | `PUT /api/modules/:id/progress` (caller's own) + progress embedded in module reads; `GET /api/modules/:id/progress` (manager roster) |
| FR-020 | **Deferred (Stretch)** — see §8. Trivial once wanted: lowest-`position` module the trainee hasn't completed |

**Status quo:** `modules` table + tenant-isolation RLS exist (migration 0001); `module_progress` table
exists with `unique(module_id, user_id)` + a `score` 0–100 check, but **no `restaurant_id` and no RLS**.
`modules.content` is `jsonb` typed `<unknown>` ("structure firmed up in Phase 5"). What's missing: the
`content` contract, `position` ordering, the CRUD/progress/roster routes, and `module_progress` RLS.

**Not in this phase's path at all:** the RAG pipeline. Modules are a read/track surface, **not**
retrieval corpus — no embeddings, no chunks, no eval-set involvement (see Decision 5).

## 2. Decisions locked in brainstorming

1. **Read-and-acknowledge model.** A module is authored body text a trainee reads, then self-marks.
   **No quiz, no scoring in Phase 5.** `module_progress.score` stays nullable and unused — it remains
   FR-019-justified and reserved for a future scored assessment, but nothing writes it this phase.
2. **`content` shape (stays `jsonb`; Zod becomes its contract):**
   `{ body: markdown string, documentIds?: uuid[], menuItemIds?: uuid[] }`. The ref arrays are
   **validated to resolve within the caller's tenant on write** — honors FR-018's "optionally tied to
   docs/menu items" with no new tables (ids live in the JSON).
3. **Ordered curriculum:** add integer `modules.position`. POST appends (`COALESCE(MAX(position),-1)+1`);
   PATCH can set it to reorder; reads sort `(position, id)` ascending (curriculum order). No bulk-reorder
   endpoint in MVP — a single PATCH suffices.
4. **Progress is the caller's own**, embedded in module reads, changed via one upsert endpoint. **Plus** a
   manager-only roster read of all trainees' progress for a module (raw rows; Phase 6 adds aggregation).
5. **Modules do NOT feed `/api/ask`.** Unlike menu items (Phase 4), training modules are not retrieved or
   embedded. Deliberate non-goal — keeps Phase 5 clear of the RAG pipeline and the eval set, and respects
   "no speculative abstraction" (no FR asks for module-grounded Q&A). Revisit only if an FR does.
6. **FR-020 deferred** (Stretch tier — "after the spine works").

## 3. Architecture — modules & flow

```
src/app/api/modules/route.ts                  POST (create) · GET (list + caller progress)
src/app/api/modules/[id]/route.ts             GET (detail + caller progress) · PATCH · DELETE
src/app/api/modules/[id]/progress/route.ts    PUT (caller upserts own) · GET (manager roster)
src/lib/modules/validate.ts                   shared Zod: create/patch base, content shape
src/lib/modules/refs.ts                       assertRefsResolveInTenant(tx, rid, docIds, menuIds)
```

**Create flow** (`POST`, identical core for `PATCH`):
```
route: zod-validate → session → role guard (owner|manager)
withTenant(rid):
  assertRefsResolveInTenant(tx, rid, documentIds, menuItemIds)   -- mismatch ⇒ 400
  position = body.position ?? (SELECT COALESCE(MAX(position),-1)+1 FROM modules)   -- in-tx
  INSERT modules (restaurant_id = rid [from session], title, description, content, position)
commit → 201 {module}
```

**Read with embedded progress** (`GET` list/detail) — caller's own row via LEFT JOIN:
```
SELECT m.*, mp.status, mp.started_at, mp.completed_at
  FROM modules m
  LEFT JOIN module_progress mp ON mp.module_id = m.id AND mp.user_id = :sessionUser
  [WHERE (m.position, m.id) > cursor]            -- list only
  ORDER BY m.position, m.id  [LIMIT :limit]      -- list only
```

**Progress upsert** (`PUT …/progress`, body `{status}`):
```
route: zod-validate {status ∈ in_progress|completed} → session
withTenant(rid):
  SELECT 1 FROM modules WHERE id = :id           -- RLS-scoped; not found ⇒ 404
  INSERT INTO module_progress (module_id, user_id = :sessionUser, restaurant_id = rid,
                               status, started_at, completed_at)
    VALUES (..., per-status rule)
    ON CONFLICT (module_id, user_id) DO UPDATE SET status, started_at, completed_at
commit → 200 {progress}
```
Per-status rule: `in_progress` → set `started_at` if null, clear `completed_at`. `completed` → set
`started_at` if null, set `completed_at` if null. Idempotent on repeat; allows re-open.

**Manager roster** (`GET …/progress`):
```
route: session → role guard (owner|manager)
withTenant(rid):
  SELECT 1 FROM modules WHERE id = :id           -- RLS-scoped; not found ⇒ 404
  SELECT u.id, u.email, u.role, mp.status, mp.started_at, mp.completed_at
    FROM users u
    LEFT JOIN module_progress mp ON mp.user_id = u.id AND mp.module_id = :id
    WHERE u.restaurant_id = rid AND u.role = 'trainee'   -- users has no RLS ⇒ explicit tenant filter
    ORDER BY u.email
commit → 200 {moduleId, roster}
```
`LEFT JOIN` so trainees with no row show as `not_started` (answers "who hasn't started?"). `users` is not
RLS-backed, so the tenant scope on the users side is the explicit `restaurant_id` filter; the
`module_progress` side is RLS-scoped regardless.

## 4. Schema & migration `0005`

Two changes in one migration (mirrors the Phase 3 `0004` add-`restaurant_id`+RLS pattern).

**`modules`** — add `position integer NOT NULL DEFAULT 0`. (No rows exist in practice; any would get 0.
`content` stays `jsonb` — Zod is its contract, not the DB.)

**`module_progress`** — protect the last unprotected data table:
- add `restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE` **nullable** → backfill
  `UPDATE module_progress mp SET restaurant_id = m.restaurant_id FROM modules m WHERE m.id = mp.module_id`
  → `ALTER COLUMN restaurant_id SET NOT NULL` (safe even on the empty table).
- `ENABLE` + `FORCE ROW LEVEL SECURITY`; `CREATE POLICY "tenant_isolation" … USING/WITH CHECK
  (restaurant_id = current_setting('app.restaurant_id', true)::uuid)` — identical idiom to the other tables.
- add `index("module_progress_restaurant_idx")` (consistent with the other denormalized tables).
- `restaurant_id` is **server-set from the session** on every write → defense in depth: app filter →
  RLS `WITH CHECK` backstop. The existing `unique(module_id, user_id)` is the upsert conflict target.

RLS statements are **hand-written** in the migration SQL (Drizzle won't emit policies — per the
`0001`/`0004` precedent). `schema.ts` gains `position` and `restaurantId` on the two tables.

## 5. API contract

Follows `docs/api.md`: error envelope, tenancy never a client input, anti-enumeration 404s, cursor
pagination. The deferred `/api/progress` folds into a module sub-resource (progress is always a user's).

| Route | Roles | Success |
|---|---|---|
| `POST /api/modules` | owner\|manager | `201 {module}` |
| `GET /api/modules?cursor=&limit=` | any authenticated | `200 {modules, nextCursor}` — `(position, id)` asc, default 20, summaries + caller's progress |
| `GET /api/modules/:id` | any authenticated | `200 {module}` — full `content` + caller's progress |
| `PATCH /api/modules/:id` | owner\|manager | `200 {module}` (partial; ≥1 field; explicit `null` clears `description`) |
| `DELETE /api/modules/:id` | owner\|manager | `204` (hard delete; cascades the module's progress rows) |
| `PUT /api/modules/:id/progress` | any authenticated | `200 {progress}` — upserts **the caller's own** row |
| `GET /api/modules/:id/progress` | owner\|manager | `200 {moduleId, roster}` — all trainees' progress for this module |

**Write body (Zod; unknown keys rejected):**

| Field | Rule |
|---|---|
| `title` | string 1–200, **required on POST** |
| `description` | string ≤ 2000, nullable |
| `content` | object, **required on POST**: `{ body: string 1–50000 (markdown); documentIds?: uuid[] ≤ 50; menuItemIds?: uuid[] ≤ 50 }`. Ref ids validated to resolve in the caller's tenant (§6) |
| `position` | int ≥ 0, optional. Omitted on POST ⇒ append (`COALESCE(MAX(position),-1)+1`); on PATCH ⇒ moves the module |

PATCH: any subset, **≥1 field** (empty ⇒ 400); explicit `null` clears `description`. A `content` update
replaces the whole object and re-validates refs.

**Shapes (camelCase):**
- `ModuleSummary` (list): `id, title, description, position, createdAt, updatedAt, refCounts {documents, menuItems}, progress {status, startedAt, completedAt}` — **no `body`** (detail-only, mirroring documents list vs detail).
- `Module` (detail): summary fields + `content {body, documentIds, menuItemIds}`.
- `Progress` (PUT result): `{moduleId, status, startedAt, completedAt}`.
- `RosterEntry`: `{user {id, email, role}, status, startedAt, completedAt}` — `role='trainee'` users in the tenant; `not_started` for those without a row.

**Absent progress is normalized, never null:** in module reads (list + detail) the LEFT JOIN yields no
row when the caller hasn't started, which the API returns as `progress: {status: "not_started",
startedAt: null, completedAt: null}` — a stable shape, never `null`. (Same normalization as `RosterEntry`.)

**Progress upsert semantics** (`PUT …/progress`, body `{status}`):
- `status ∈ {in_progress, completed}` (an absent row already means `not_started`; no explicit reset in MVP).
- `restaurant_id` + `user_id` server-set from the session (never client input).
- Transitions per §3; idempotent on repeat; one row per `(module_id, user_id)`.

**Scope/guards:** writes = owner|manager; module reads + own-progress = any authenticated; roster =
owner|manager. Foreign-tenant / missing / non-uuid id ⇒ `404` (anti-enumeration; RLS → zero rows).

## 6. Error handling

| Failure | Behavior |
|---|---|
| Zod invalid (bad field, unknown key, empty PATCH) | `400 VALIDATION`, no DB touch |
| `documentIds`/`menuItemIds` id doesn't resolve in tenant | `400 VALIDATION` (count of resolved ids ≠ requested) — no leak |
| No session | `401` |
| Trainee on writes or roster read | `403 FORBIDDEN` |
| Foreign / missing / non-uuid id | `404 NOT_FOUND` (anti-enumeration) |
| Invalid `?cursor=` | **`400`** — parsed defensively. Deliberately correct here, unlike the older documents/menu-items endpoints that currently `500` (carried-forward gap); Phase 7 aligns those |

**Ref validation** = one tenant-scoped round-trip: `SELECT count(*) FROM documents WHERE id = ANY(:docIds)`
and likewise `menu_items`, both inside `withTenant` (RLS-scoped); each count must equal the requested
array length, else `400`. Empty/absent arrays skip the check.

**No concurrency lock** (contrast with Phase 4): modules have no derived chunk set, so no
`pg_advisory_xact_lock`. The only race — two concurrent POSTs computing the same `MAX(position)+1` — is
harmless; the `(position, id)` sort breaks ties deterministically. **No `502`/no AI failure modes** —
modules never call OpenAI.

## 7. Testing & Definition of Done

**vitest (Docker Postgres for DB/RLS; OpenAI not involved), added to the current 108:**
- **Validation:** each field rule, unknown-key rejection, empty-PATCH 400, `body` length bounds,
  ref-array caps; ref ids that don't resolve (incl. a **cross-tenant** id) ⇒ 400; valid refs stored.
- **Role guards:** trainee `POST/PATCH/DELETE` ⇒ 403; trainee roster read ⇒ 403; trainee `GET`
  list/detail ⇒ 200; trainee `PUT` own progress ⇒ 200.
- **CRUD + ordering:** create appends `position`; list sorted `(position, id)`; `PATCH position`
  reorders; `DELETE` ⇒ row gone **and** its progress rows cascaded.
- **Progress:** `PUT in_progress` sets `started_at`; `PUT completed` sets `completed_at`; idempotent
  repeat; re-open clears `completed_at`; second PUT updates (no duplicate row).
- **Embedded progress:** two different users each see only their own progress in reads.
- **Roster:** manager sees all trainees incl. `not_started` (LEFT JOIN); reflects a completion.
- **RLS / isolation (phase headline — `module_progress`'s first policy):** tenant B can't read A's
  modules, can't `PUT` progress on A's module (404), can't appear in A's roster; `WITH CHECK` blocks
  writing progress with a foreign `restaurant_id`.
- **Migration `0005`:** applies cleanly; `module_progress.restaurant_id` NOT NULL + RLS enabled/forced;
  `modules.position` present.

**DoD:** `tsc` clean · full vitest green · `next build` green · migration `0005` applied · CLAUDE.md
status updated. **Eval is not a Phase 5 gate** — no retrieval/AI surface is added, so `eval/` is green by
construction; run `eval:run` once as a no-regression sanity check, not a gate.

## 8. Out of scope (deferred)

- Quiz / scoring (`score` reserved, see Decision 1) — a future scored-assessment feature.
- **FR-020 adaptive next-step** (Stretch) — trivial later: lowest-`position` module not yet completed.
- Phase 6 analytics: aggregation/rollups + "questions asked" per trainee (FR-021).
- **Modules as `/api/ask` retrieval corpus** (Decision 5 — deliberate non-goal).
- Module versioning / draft-publish states / rich-media attachments.
- Bulk-reorder endpoint (single PATCH `position` suffices for MVP).
- Per-trainee cross-module manager view (`GET /api/users/:id/progress`) — Phase 6 if needed.
- Manager UI (demo needs it by Phase 8; all phases so far are API-only).

## 9. Open items carried to the plan

- Migration `0005` mechanics: confirm whether Drizzle generates the `position` + `restaurant_id` column
  DDL so only the RLS policy + backfill are hand-appended (per `0001`/`0004`); order = add column →
  backfill → NOT NULL → enable/force RLS → policy → index.
- Generalize the documents cursor helper (currently `createdAt` desc) to ascending `(position, id)`, or
  add a small variant; keep `limit` default 20 (house idiom).
- `refCounts` in the list: compute from the stored `content` arrays (no extra query) — confirm at plan time.
- Confirm `ON CONFLICT (module_id, user_id)` targets the existing `module_progress_uq` constraint.
