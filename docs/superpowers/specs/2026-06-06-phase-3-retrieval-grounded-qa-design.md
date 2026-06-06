# Phase 3 Design — Retrieval + Grounded Q&A

**Status:** approved design (brainstorming output), ready to turn into an implementation plan.
**Phase:** 3 (the crown jewel). **FRs:** FR-010–014 (foundational touches on FR-023, FR-025).
**Depends on:** Phase 1 (`withTenant`, `reg_app` non-superuser role, RLS pattern, auth guard +
error envelope) and Phase 2 (the ingestion pipeline: `embed()`, chunking, `chunks` table,
`usage_events` cost pattern). **Date:** 2026-06-06.

This spec is the *what* and *why* for Phase 3. It refines — does not replace — the locked contracts
in `docs/rag.md` (the whole RAG pipeline), `docs/api.md §2.3` (`POST /api/ask`), and `schema.ts`
(`conversations`/`messages`/`message_sources`/`usage_events`). Where this spec and those docs agree,
those docs remain canonical. Two values are **David's to finalize** and are called out as such: the
grounding **threshold** (§4) and the **prompt template** (§5).

---

## 1. Goal & FR map

A trainee asks a question; the system embeds it, retrieves the asking restaurant's most similar
chunks, and **either** answers grounded in those chunks with citations **or** honestly declines —
never guesses. The answer and the exact chunks that grounded it are persisted as an audit trail.
Tenant isolation holds at every step. All 15 eval questions run against a real seed corpus this
phase, and the threshold is calibrated from that real retrieval distribution.

| FR | Requirement | Delivered by |
|---|---|---|
| FR-010 | Tenant-scoped top-k vector search | `qa/retrieve.ts` — the locked `rag.md §3` query inside `withTenant`; RLS backstop |
| FR-011 | Grounded answer with citations (server-side key) | `qa/answer.ts` + `ai/generate.ts`; answer built from retrieved chunks, cited `[n]`; key `server-only` |
| FR-012 | "I'm not sure" fallback on weak retrieval | Threshold gate in `answer.ts`: below cutoff → `grounded:false`, fallback string, **no LLM call** |
| FR-013 | Conversation history | `conversations`/`messages`/`message_sources` rows written per Q&A; persist-only (answers are standalone) |
| FR-014 | Allergen/food-safety caution | Prompt's allergen clause + structural safety bias (weak retrieval → decline, never hedge) |
| FR-023 (seed) | Usage/cost | `usage_events`: one `embedding` row per question, one `completion` row per grounded answer |
| FR-025 (seed) | Structured logging | Route/orchestrator log question id + grounded decision + similarity + latency; never the key |

Streaming (`api.md §3`) stays **deferred** — JSON `AskResponse` is the testable contract; SSE is an
additive UX layer for Phase 3 polish that doesn't change the contract's substance.

---

## 2. Decisions locked in brainstorming

1. **Full seed corpus + menu now.** Stand up a real demo corpus (documents *and* `menu_items`) so all
   15 eval questions run this phase and the threshold is calibrated against the complete distribution.
   This intentionally pulls a *thin* slice of menu data forward; full menu CRUD + richer menu-aware
   reasoning (FR-015–017) still belong to Phase 4.
2. **Menu data joins retrieval via one uniform path.** Each `menu_item` is deterministically rendered
   to a text card and embedded into the **same `chunks` table** (under a synthetic per-restaurant
   "Menu" document). There is exactly one retrieval path — a single filtered vector search — for both
   uploaded docs and menu data. No second structured retriever (that complexity is Phase 4).
3. **Generation model = `gpt-4.1-mini`**, behind a swappable seam (`ai/generate.ts`), `temperature: 0`.
   A single constant to change; the eval set is the gate that justifies it.
4. **History is persist-only; answers are standalone.** Each question is embedded and retrieved
   independently; the LLM sees only the current question + retrieved chunks. Prior turns are saved for
   display/audit but **not** sent to the model (matches `rag.md`; avoids grounding drift and
   query-rewriting complexity — a Phase 7 candidate if ever needed).
5. **Streaming deferred** — JSON contract only.

---

## 3. Architecture — modules & end-to-end flow

`POST /api/ask` runs entirely inside one `withTenant(restaurantId, tx => …)` transaction, so RLS is
active and the answer + its audit trail commit atomically.

```
route.ts            validate AskReq (Zod) · requireSession (any role) · restaurantId ← session (NEVER client)
   │ withTenant(restaurantId, tx => answer(tx, {restaurantId, userId, restaurantName, question, conversationId}))
   ▼
answer.ts  (orchestrator — DAVID owns the grounding/fallback logic)
   1. embed(question)                    → qEmb        [ai/embeddings.ts]   + usage_event(embedding)
   2. retrieve(tx, qEmb, k=5)            → ranked[]    [qa/retrieve.ts]
   3. gate: ranked.length>0 && ranked[0].similarity >= THRESHOLD ?
        NO  → grounded:false · FALLBACK_TEXT · sources:[]        ← NO LLM CALL (rag.md §6)
        YES → buildPrompt(restaurantName, ranked, question)      [qa/prompt.ts]
              generate(messages)         → text        [ai/generate.ts]    + usage_event(completion)
              if text === FALLBACK_TEXT  → grounded:false (model declined from context)
   4. persist (same tx): conversation (create if new / verify ownership) + user msg + assistant msg
              + message_sources (grounded only, one per retrieved chunk fed to the prompt)
   5. return AskResponse { answer, grounded, sources, conversationId, messageId }
```

**New files**

| File | Responsibility | Owner |
|---|---|---|
| `src/lib/ai/generate.ts` | Completion seam: `gpt-4.1-mini`, cost constants, `server-only`, `temperature:0` | Forge scaffolds |
| `src/lib/qa/retrieve.ts` | Tenant-scoped vector search (the `rag.md §3` query) + D2 recall settings | **David** (owns the query) |
| `src/lib/qa/prompt.ts` | System prompt + numbered-context builder; `FALLBACK_TEXT` constant | **David** (owns the wording) |
| `src/lib/qa/answer.ts` | Orchestrator: embed → retrieve → gate → generate/fallback → persist | **David** (owns the grounding logic) |
| `src/lib/qa/menu-card.ts` | `menu_item` → deterministic text card (reused by Phase 4 menu CRUD) | Forge scaffolds |
| `src/app/api/ask/route.ts` | The handler: validate, auth, tenant-from-session, return `AskResponse` | Forge scaffolds |
| `drizzle/0004_*.sql` + `schema.ts` | RLS + denormalized `restaurant_id` on `messages`/`message_sources` | Forge |
| `eval/seed.ts` | Idempotent demo-restaurant-a (+ -b) corpus: docs + menu items | Forge |
| `eval/run.ts` | Calibration + verification harness over `eval/eval-set.yaml` | Forge |

**Reused as-is:** `withTenant` · `embed()` · `requireSession`/`hasRole` · the HTTP error envelope ·
the `usage_events` cost-row pattern.

The three **David-owned** units (`retrieve`, `prompt`, `answer`) are the interview/investor surface —
the tenant-scoped query, the grounding/fallback logic, and the prompt. Per the AI-usage discipline he
writes these and explains them back before they're accepted.

---

## 4. Retrieval + the threshold gate

### 4.1 Retrieval (`qa/retrieve.ts`, FR-010)

The locked `rag.md §3` query, via Drizzle `sql`, inside the tenant transaction:

```sql
SELECT id, document_id, text, 1 - (embedding <=> $qEmb) AS similarity
FROM chunks
WHERE restaurant_id = current_setting('app.restaurant_id')::uuid   -- RLS also enforces this
ORDER BY embedding <=> $qEmb
LIMIT 5;                                                            -- k = 5 start
```

Returns `{ chunkId, documentId, text, similarity }[]`, sorted best-first. `restaurant_id` is the
first predicate (isolation in the query) and RLS is the backstop (defense in depth).

**D2 filtered-HNSW recall ladder** (HNSW filters *after* walking the index, so a sparse tenant can get
back <k). At the top of the tenant tx, set both `LOCAL` (transaction-scoped, no leak):
- `SET LOCAL hnsw.ef_search = 100` — rung 1, cheap recall headroom.
- `SET LOCAL hnsw.iterative_scan = 'relaxed_order'` — rung 2, available on the live **pgvector 0.8.2**,
  built for filtered search.

The eval harness (§6) is how we confirm the ladder actually delivers k results for sparse tenants;
rung 3 (hash-partition `chunks` by tenant) stays post-MVP.

### 4.2 The gate (`qa/answer.ts`, FR-012/FR-014) — David's to own

- `THRESHOLD` is a single named constant. **Placeholder 0.35**, with a comment that it is *calibrated,
  not guessed*, and a pointer to `eval/run.ts`. **David finalizes this number from the eval
  distribution** (§6) before the phase closes.
- Gate: `ranked.length > 0 && ranked[0].similarity >= THRESHOLD`.
  - **Pass** → feed the retrieved top-k to the prompt (the model cites the ones it uses).
  - **Fail** → `FALLBACK_TEXT` immediately, **no LLM call** (saves cost; removes the temptation to
    improvise — `rag.md §6`).
- **Safety bias is structural:** a weak/uncertain retrieval can only resolve to `grounded:false`,
  never a hedge (FR-014). When safety-critical questions sit near the line, calibration biases the
  threshold *up* — a missed answer is recoverable, a wrong allergen answer is not.

---

## 5. Prompt template + generation seam

### 5.1 Prompt (`qa/prompt.ts`, FR-011/FR-014) — David's to finalize

`buildPrompt(restaurantName, chunks, question) → ChatMessage[]` encoding the locked `rag.md §5` rules.
Forge scaffolds the structure and a first-draft string marked `// DAVID: finalize wording`; **David
writes the final wording and explains it back** before lock.

```
SYSTEM:   role for {restaurant_name} + the 4 rules:
          (1) answer ONLY from the numbered context;
          (2) if the context lacks the answer, reply EXACTLY with FALLBACK_TEXT — no outside knowledge, no guessing;
          (3) allergen/dietary/food-safety: state only what the context explicitly says; if incomplete/absent,
              say so and advise confirming with the kitchen/manager; never reassure "safe" beyond the context;
          (4) be concise — staff may read this mid-shift.
CONTEXT:  "[1] {chunk_1.text}\n[2] {chunk_2.text}\n…"     ← numbered; [n] maps to the n-th chunk → its chunkId
USER:     {question}
```

- **`FALLBACK_TEXT`** is a shared constant used in *two* places: the prompt's rule (2) **and** the
  weak-retrieval path in `answer.ts`. So "below threshold" and "model declined" produce identical
  user-facing text and both set `grounded:false`.
- Citation `[n]` → the n-th context chunk → its `chunkId`. We do **not** parse `[n]` to *decide*
  grounding (the threshold already did), nor to select which sources to persist. The returned
  `sources[]` and the `message_sources` rows are the **full retrieved grounding set** fed to the
  prompt (each with its retrieval `similarity`); the inline `[n]` markers are a display nicety the
  frontend can map back to those sources. (A later phase could narrow `sources[]` to only the `[n]`
  actually referenced — not worth the parsing fragility in the MVP.)

### 5.2 Generation (`ai/generate.ts`, FR-011) — mirrors `embeddings.ts`

```ts
export const COMPLETION_MODEL = "gpt-4.1-mini";
// pricing constants — CONFIRM against current OpenAI pricing at build time:
//   input ≈ $0.40 / 1M tokens, output ≈ $1.60 / 1M tokens
export async function generate(messages): Promise<{ text; inputTokens; outputTokens }>;
export function completionCostUsd(inTok, outTok): number;
```

- `server-only`; lazy OpenAI client; key never logged. `temperature: 0` — grounded Q&A wants
  determinism (and reproducible evals), not creativity.
- Returns token counts so `answer.ts` writes a `usage_events(kind:'completion')` row with real cost.

---

## 6. Seed corpus + eval calibration harness

This is what makes "full corpus + menu now" real and the threshold defensible.

### 6.1 `eval/seed.ts` — idempotent, committed fixtures

**demo-restaurant-a** (the ruler's `restaurant_scope`):
- **~6 documents**, authored to answer the doc-grounded questions, ingested through the *real*
  pipeline (upload → parse → chunk → embed) so retrieval sees production-shaped chunks:
  wine list w/ by-the-glass Burgundy *(Q07)* · pairing guide naming the short-rib pairing *(Q06)* ·
  service-standards SOP w/ tableside wine service *(Q09)* · complaint-handling SOP *(Q10)* · staff
  handbook / dress code *(Q11)* · food-safety / celiac SOP *(Q12)*.
- **~7 `menu_items`** with real `allergens` (enum) + `dietary_flags`, each rendered via `menu-card.ts`
  and embedded as chunks: branzino *(Q01)* · mushroom risotto = vegetarian *(Q02)* · several flagged
  `gluten_free` *(Q03)* · seared scallops = `shellfish`, **no `milk`** *(Q04)* · an item flagged
  `tree_nuts` *(Q05)* · grilled chicken / pollo a la parrilla *(Q14)* · braised short rib *(Q06)*.
- **Deliberately absent** so the fallback path *must* fire: no NA-pairing doc *(Q08)*, no
  alcohol-service policy *(Q13)*, no wifi info *(Q15)*. The corpus is designed around the fallbacks,
  not just the hits.

**demo-restaurant-b** — a small *different* corpus, solely to prove cross-tenant isolation.

`menu-card.ts` renders faithfully from the controlled vocabulary: it lists the *recorded* allergens
(e.g. scallops → "Allergens (recorded): shellfish"); it never asserts an item is free of an unlisted
allergen. The prompt's allergen clause handles absence ("not recorded — confirm with the kitchen"),
keeping the safety answer source-backed (FR-014).

### 6.2 `eval/run.ts` — calibration + verification (Phase 8 hardens into a CI gate)

1. For all 15 questions: embed → retrieve top-k under A's scope → record **top-1 similarity**, whether
   the expected source is in top-k (**hit-rate**), and the gate decision at the current `THRESHOLD`.
2. Print the **distribution table** — answerable top-1 sims vs. the three fallbacks' — so David *sees
   the gap* and picks the threshold from data, biasing toward refusal near the safety line.
3. Run full generation for answerable Qs; print `answer + sources` for David to score `pass_condition`
   by eye. **Auto-assert** the mechanical parts: the three fallbacks emit `FALLBACK_TEXT`; no safety
   answer asserts "safe" beyond source.
4. **Isolation:** run A's questions under B's scope → assert **0 A-chunks** retrieved (and the
   reverse). Any leak = hard fail.

Output: a PASS/FAIL summary + a recommended threshold. This is the loop where David finalizes the two
owned values. Phase 8 adds an LLM judge for full automation and wires it into CI.

---

## 7. Persistence + RLS (migration 0004)

### 7.1 What `answer.ts` writes (all in the tenant tx — atomic)

| Step | Always | Grounded only |
|---|---|---|
| `conversations` | insert if no `conversationId`; else verify ownership (`restaurant_id` + `user_id`) | — |
| `messages` (role=user) | the question | — |
| `messages` (role=assistant) | the answer (or `FALLBACK_TEXT`) | — |
| `message_sources` | — | one row per retrieved chunk that grounded the answer: `{ messageId, chunkId, similarity }` |
| `usage_events` | one `embedding` row (question) | + one `completion` row (answer) |

A `conversationId` from another tenant/user resolves to *not found* → start a fresh conversation (no
error oracle, no leak; RLS backstops).

### 7.2 Migration 0004 — RLS on the conversation tables

Completes the RLS deliberately deferred in `schema.ts` ("RLS … implemented in their phase") — this is
their phase. Follows the **established denormalization pattern** (`chunks`/`document_blobs` carry
`restaurant_id` so the identical policy applies):
- `ALTER TABLE messages ADD COLUMN restaurant_id uuid NOT NULL REFERENCES restaurants(id)` (+ index);
  same for `message_sources`. (`conversations` already has `restaurant_id`.) No backfill — these
  tables are empty until this phase.
- `ENABLE` + `FORCE ROW LEVEL SECURITY` on `conversations`, `messages`, `message_sources`, each with
  the `tenant_isolation` policy (`USING` + `WITH CHECK` on `current_setting('app.restaurant_id',
  true)`). `reg_app` is a non-superuser, so `FORCE` actually bites.
- `schema.ts` updated to match (two new columns + indexes).

This keeps the defense-in-depth chain complete for the Q&A tables: session → query filter → RLS.

---

## 8. Error handling

The cardinal rule: **never fabricate to cover an error.**

| Condition | Behavior |
|---|---|
| OpenAI embed/generate failure | error envelope (502/503) — not a fake answer |
| Empty / sparse retrieval (below threshold) | `grounded:false` fallback — not an error |
| Invalid `AskReq` | 400 (Zod) via the error envelope |
| No / invalid session | 401 |
| Foreign or missing `conversationId` | start a fresh conversation (no error oracle) |
| Any DB error | 500; the tenant tx **rolls back** — no half-written answer/sources |

---

## 9. Testing & Definition of Done

**Testing** (vitest + real Postgres, same harness as Phase 2):
- *Unit:* `retrieve` (tenant-scoped, ordered) · `prompt` (numbered context, shared refusal string) ·
  `menu-card` (deterministic; the "dairy not recorded" case) · `generate` (mocked OpenAI) · `answer`
  (gate-pass → grounded + sources + two usage rows; **gate-fail → fallback, `generate` never called,
  no completion usage**; model-refusal → `grounded:false`).
- *Integration:* `/api/ask` (auth required; new vs. existing conversation; `AskResponse` shape; rows
  persisted).
- *Isolation:* A-question under B-session → 0 A-chunks; RLS blocks cross-tenant read of
  `messages`/`message_sources`; `WITH CHECK` blocks cross-tenant write.

**Definition of Done** (none optional):
- **FR-010** isolation test green · **FR-011** grounded answers cite sources, key `server-only` ·
  **FR-012** Q08/Q13/Q15 → fallback, no LLM · **FR-013** Q&A persisted per trainee with grounding
  chunks · **FR-014** safety questions conservative + source-backed, **0 fabricated allergen/food-
  safety facts**.
- **Eval gate:** retrieval hit-rate **≥90%** on non-fallback Qs · **100%** fallback correctness ·
  **0** cross-tenant leaks.
- **Threshold** finalized by David from the eval distribution (not the 0.35 placeholder) · **prompt
  template** finalized by David and **explained back**.
- `tsc --noEmit` clean · `next build` green · full vitest suite green · P50<2s / P95<4s sanity-checked
  (full NFR perf pass remains Phase 7).

---

## 10. Out of scope (explicitly deferred)

- **Token streaming** of `/api/ask` → Phase 3 polish / later (contract unchanged).
- **Multi-turn context** in the prompt + query rewriting → Phase 7 if ever needed.
- **Full menu CRUD + structured menu-aware retrieval** (FR-015–017) → Phase 4. This phase seeds menu
  data and renders it to chunks; it does not build the second structured retriever or the menu API.
- **LLM-judge eval automation + CI eval gate** → Phase 8 (the harness is runnable now).
- **Per-tenant rate limiting / cost caps** (FR-026) → Phase 7.

---

## 11. Open items carried to the plan

- Confirm `gpt-4.1-mini` token pricing against current OpenAI pricing when writing `ai/generate.ts`.
- Author the six demo-restaurant-a documents (and the demo-restaurant-b set) — realistic, a few
  hundred words each; map dish names to the eval's placeholders.
- David: finalize `THRESHOLD` from `eval/run.ts` output; finalize the prompt wording in `qa/prompt.ts`.
