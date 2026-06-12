# Phase 4 Design — Menu Management + Menu-Aware Answers

**Date:** 2026-06-12
**FRs:** FR-015 (structured menu CRUD), FR-016 (menu-aware answers, cited),
FR-017 (menu changes reflected immediately — no manual re-ingest)
**Depends on:** Phase 1 (auth/roles/RLS — `menu_items` policies live since migration 0002),
Phase 2 (`embed()` boundary, usage events), Phase 3 (`menuCard()` renderer, synthetic
"Menu" document pattern, tenant-scoped retrieval, eval harness).

---

## 1. Goal & FR map

A manager maintains the restaurant's menu as structured rows (name, description,
ingredients, allergens, dietary flags, price, active), and every change is retrievable
by `/api/ask` the moment the write returns — same retrieval path, same citations, same
grounding rules as documents.

| FR | Where it lands |
|---|---|
| FR-015 | `POST/GET /api/menu-items`, `PATCH/DELETE /api/menu-items/:id` |
| FR-016 | Already proven in Phase 3 (menu cards in `chunks`; eval Q01/Q02/Q04/Q14) — Phase 4 keeps it true under CRUD |
| FR-017 | `rebuildMenuChunks()` — synchronous full-menu rebuild inside the write transaction |

**Status quo:** `menu_items` table + RLS exist (schema, migration 0002); `menuCard()`
renders deterministic safety-worded text cards (`src/lib/qa/menu-card.ts`); the Phase 3
*seeder* embeds cards as chunks under a synthetic "Menu" document. What's missing: CRUD
routes, the rebuild-on-write mechanism, and a single shared code path so the seeder and
the API can't drift.

## 2. Decisions locked in brainstorming

1. **API only.** No UI page in Phase 4 (consistent with Phases 1–3; demo UI is later).
2. **Roles:** writes (`POST/PATCH/DELETE`) require `owner|manager`; `GET` list is open to
   all authenticated roles (RLS-scoped; plausible staff consumer later).
3. **Inactive items are invisible to Q&A.** `active=false` ⇒ no menu card ⇒ questions
   about the dish hit the honest fallback. Menu = what we serve. `PATCH {active}` covers
   the "86'd tonight / back tomorrow" workflow; `DELETE` is a hard delete.
4. **FR-017 mechanism = Approach A: synchronous full-menu rebuild** in the write
   transaction (alternatives considered: per-item chunk linkage — a migration plus
   `chunkIndex` bookkeeping to save fractions of a cent; async via the polling worker —
   makes "immediately" mean "within the poll interval" and needs an enum migration +
   second worker pipeline. Both rejected as complexity without need at current scale).
5. **Zero migrations.** Schema already carries everything Phase 4 needs.

## 3. Architecture — modules & flow

```
src/app/api/menu-items/route.ts        POST (create) · GET (list)
src/app/api/menu-items/[id]/route.ts   PATCH (partial update) · DELETE
src/lib/menu/rebuild.ts                ensureMenuDocument() · rebuildMenuChunks()
eval/seed.ts                           REFACTOR: ingestMenu() → the same two helpers
```

Write-path flow (identical for create / update / delete / toggle):

```
route: zod-validate → session → role guard (owner|manager)
withTenant(rid):
  SELECT pg_advisory_xact_lock(hashtextextended('menu:'||rid, 0))
  write the menu_items row            (insert / update / delete)
  rebuildMenuChunks(tx, rid):
    items  = SELECT * FROM menu_items WHERE active ORDER BY name, id   (in-tx)
    cards  = items.map(menuCard)
    embed(cards)                       (ONE batched call — in-tx, bounded)
    doc    = ensureMenuDocument(tx, rid)
    DELETE chunks WHERE document_id = doc.id
    INSERT chunks (contiguous chunk_index 0..n-1, denormalized restaurant_id)
    INSERT usage_events (kind='embedding', actor userId)
commit → 2xx
```

**`ensureMenuDocument`:** locates the synthetic Menu document by well-known
`content_hash = 'menu:' + restaurantId` (`title: "Menu"`, `source_type: 'text'`,
`status: 'done'`); creates it on the first menu write. The Phase 3 seeder's
`seed-menu-${rid}` hash is replaced by this constant when the seeder refactors onto
`ensureMenuDocument` — `eval:seed` recreates its restaurants from scratch each run, so
no compatibility shim is needed.

**Card order = `ORDER BY name, id`:** deterministic across rebuilds (stable chunk
diffs, reproducible evals), human-sensible, and independent of edit history.

## 4. Why synchronous rebuild is safe (constraints #4, #7, #9)

- **Bounded work:** one batched `embed()` call over tens of short cards (~50–100 tokens
  each) — roughly $0.0001 and ~1s added to a *write*. Reads and `/api/ask` are untouched.
  Constraint #4 ("no long ingestion in a request") targets unbounded parsing of uploaded
  bytes; this is a fixed-size call over structured rows already in the DB. The existing
  `embed()` guard (>2048 inputs throws) is the pathological-menu backstop.
- **Atomic:** the embed happens before any chunk mutation, and the row write + chunk swap
  share one transaction. Embed failure ⇒ full rollback (row included) ⇒ 502; the menu and
  its chunks can never diverge. Retry = re-issue the write.
- **Concurrency:** `pg_advisory_xact_lock` keyed on the restaurant serializes menu writes
  per tenant. Without it, two concurrent edits each rebuild from a snapshot missing the
  other's change and the last commit wins with a stale card set. Transaction-scoped ⇒
  auto-released on commit/rollback; cross-tenant writes don't contend.
- **Cost tracking:** every rebuild logs an `embedding` usage event (constraint #9 /
  FR-023 groundwork).

## 5. API contract (follows `docs/api.md`: error envelope, cursor pagination)

### `POST /api/menu-items` — owner|manager
Body (Zod; `additionalProperties` rejected):

| Field | Rule |
|---|---|
| `name` | string, 1–200 chars, required |
| `description` | string ≤ 2000, optional |
| `ingredients` | string[] (each 1–100 chars), optional |
| `allergens` | enum[] — must match the DB `allergen` vocabulary exactly, optional |
| `dietaryFlags` | string[], optional — each flag is lowercased+trimmed by the API (transform, not reject), then must match `[a-z0-9_]{1,32}` or the request 400s |
| `price` | number ≥ 0, ≤ 2 decimal places (stored as numeric string), optional |
| `active` | boolean, default `true` |

→ `201 {menuItem}` (full row, camelCase). Duplicate names allowed by design
(lunch/dinner variants are the restaurant's business).

### `GET /api/menu-items` — any authenticated role
`?cursor=&limit=` (same cursor idiom as `GET /api/documents`, newest-first)
→ `200 {items: MenuItem[], nextCursor: string|null}`. Includes inactive items —
managers must see what's 86'd; invisibility is a Q&A property, not a listing one.

### `PATCH /api/menu-items/:id` — owner|manager
Partial body: any subset of the POST fields (all optional, **at least one required**;
`400` on empty). Explicit `null` clears a nullable field (description, ingredients,
allergens, dietaryFlags, price). → `200 {menuItem}`.
Foreign-tenant or missing id → **404** (anti-enumeration — RLS returns zero rows; same
behavior as `GET /api/documents/:id`).

### `DELETE /api/menu-items/:id` — owner|manager
Hard delete → `204`. Foreign/missing → 404. Rebuild runs (card disappears).

All four: `401` no session · `403` staff on writes · standard error envelope.

## 6. Error handling

| Failure | Behavior |
|---|---|
| Zod invalid | `400 VALIDATION` envelope, no DB touch |
| No session | `401` |
| Staff write | `403 FORBIDDEN` |
| Foreign/missing id | `404 NOT_FOUND` (anti-enumeration) |
| OpenAI embed fails | tx rollback (row write included) → `502 EMBED_FAILED`; client retries the whole write |
| Zero active items | Legal state: Menu doc keeps zero chunks; menu questions fall back honestly |

## 7. Testing & Definition of Done

**vitest (OpenAI mocked, Docker Postgres for DB/RLS), added to the existing 83:**
- Validation unit tests: each field rule, unknown-key rejection, empty PATCH 400.
- Role guard: staff `POST/PATCH/DELETE` → 403; staff `GET` → 200.
- Create → Menu doc exists, chunk set contains the new card (mock embed = deterministic
  vectors), `chunk_index` contiguous, usage event written.
- Update name/allergens → old card gone, new card present.
- `PATCH active=false` → card absent; `active=true` → card back.
- DELETE → row + card gone.
- **Atomicity:** embed mock rejects → menu row NOT persisted, old chunks intact, 502.
- Isolation: tenant B sees neither A's items (list) nor A's ids (PATCH/DELETE → 404);
  rebuild touches only A's Menu doc.
- Determinism: same items ⇒ identical card list across two rebuilds.

**Eval regression:** after the seeder refactor, `npm run eval:seed && npm run eval:run`
— all four gates PASS (menu questions Q01/Q02/Q04/Q14 are the canaries).

**DoD demo (FR-017 acceptance):** `PATCH` a dish's allergens → `POST /api/ask` the
matching eval question → the answer cites the new value immediately. Plus: `tsc` clean,
full vitest green, `next build` green, CLAUDE.md status updated.

## 8. Out of scope (explicitly deferred)

- Manager UI (later phase; demo needs it by Phase 8).
- Menu *sections/categories*, item photos, multi-menu (lunch/dinner) modeling.
- Per-item chunk linkage / incremental re-embed (Approach B) — revisit only if menus or
  edit rates grow enough that the full rebuild measurably hurts.
- Worker-based async rebuild (Approach C) — the upgrade path if menus stop being small.
- Per-tenant write rate limiting (FR-026, Phase 7).

## 9. Open items carried to the plan

- Exact Zod schema reuse: share field validators between POST and PATCH (one schema,
  `.partial()` + min-one-key refinement).
- Whether `GET` list wants an `?active=` filter (cheap; decide at plan time — default
  is no filter, return everything).
- The `hashtextextended` advisory-lock key: confirm signature against Postgres 16 docs
  in the plan's first task (fallback: two-int4 `pg_advisory_xact_lock(hashtext(...), 0)`).
