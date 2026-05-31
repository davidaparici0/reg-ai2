# Phase 2 Design — Document Ingestion

**Status:** approved design (brainstorming output), ready to turn into an implementation plan.
**Phase:** 2. **FRs:** FR-005–009 (foundational touches on FR-023, FR-025). **Depends on:** Phase 1
(`withTenant`, `reg_app` role, RLS on `documents`/`chunks`, the auth guard + error envelope).
**Date:** 2026-05-31.

This spec is the *what* and *why* for Phase 2. It refines — does not replace — the locked contracts
in `docs/api.md §2.2` (document upload + status), `docs/rag.md §1–2` (chunking + embedding), and
`docs/architecture.md §2` (the async ingestion flow). Where this spec and those docs agree, those
docs remain canonical. One deliberate correction to locked intent is called out in §2 (content-hash
basis).

---

## 1. Goal & FR map

PDF, end to end: an owner/manager uploads a PDF; the request returns immediately with a `pending`
job; a long-running worker parses → deterministically chunks → embeds → writes tenant-scoped
`chunks`; status moves `pending → processing → done|failed` and is visible via the API. Re-uploading
the same file produces **no** duplicate chunks. Everything the worker writes is scoped to the
document's restaurant and enforced by RLS.

| FR | Requirement | Delivered by |
|---|---|---|
| FR-005 | Upload PDF | `POST /api/documents` (owner\|manager, multipart) → `documents` row + stored bytes, `202` |
| FR-006 | Parse + chunk deterministically | Pure `chunk(text)` function (gpt-tokenizer, fixed params) — same in → same out |
| FR-007 | Embed + store in pgvector | OpenAI `text-embedding-3-small` (1536d); each `chunk` written with its `restaurant_id` |
| FR-008 | Content-hash dedup | `unique(restaurant_id, content_hash)` rejects a dup **before** any worker/embedding cost |
| FR-009 | Job status + errors, in background | Worker (`FOR UPDATE SKIP LOCKED`) drives `pending→processing→done\|failed`; errors captured |
| FR-023 (seed) | Usage/cost | One `usage_events` row per embedding call (`kind="embedding"`, tokens, cost) |
| FR-025 (seed) | Structured logging | Worker logs job id + status transitions + durations; never bytes or secrets |

DOCX/text remain **Stretch** — out of this slice (FR-005 tier). The parser is structured so adding
them later is a registration, not a rewrite (§7), but only `pdf` is registered now (YAGNI).

---

## 2. Decisions locked in brainstorming

1. **File bytes live in Postgres `bytea`**, in a **separate `document_blobs` table** (not a column on
   `documents`) so the hot status/list reads never drag MB of binary. Stays one-DB, RLS-protectable,
   no shared-filesystem coordination between the web and worker processes, zero deploy config on
   Fly/Railway. S3/object storage is the documented upgrade door for scale — not now (no tenant yet).
2. **Two-phase worker, not one long transaction.** A tiny *privileged* transaction claims one job by
   flipping its status to `processing`; the heavy work (parse/chunk/embed/write) runs in a *separate*
   `withTenant` transaction as `reg_app` under enforced RLS. The status flip is the lock — no DB lock
   or connection is held across the multi-second OpenAI calls. Rationale: scheduling is inherently
   cross-tenant; the work is tenant-scoped — keep those concerns on different connections (§5).
3. **`content_hash` = SHA-256 of the raw uploaded bytes**, computed in the request.
   **Correction to locked intent:** the `schema.ts` comment says "SHA-256 over normalized text," but
   normalized text only exists *after* parsing, which happens in the worker. Hashing raw bytes is
   cheap (ms, no parse), and — crucially — lets the unique constraint reject a duplicate **before** we
   spend any worker or embedding cost. FR-008's acceptance is "re-uploading the *same file* → no
   duplicate chunks," and same file = same bytes. The schema comment is updated to say "raw file
   bytes." (A PDF re-exported with identical text but different bytes is not "the same file" and is
   out of scope to dedup.)
4. **Re-upload is idempotent.** A byte-identical re-upload returns the **existing** document
   (`200 {documentId, status}`), never a duplicate row or duplicate chunks. Refinement: if the
   existing document is in `failed` state, the re-upload flips it back to `pending` so a previously
   broken parse retries (reusing the kept blob).
5. **Tokenizer = `gpt-tokenizer`** (cl100k_base, the encoding `text-embedding-3-small` uses). Pure JS,
   ~50KB, no WASM artifact and no `encoder.free()` memory footgun (which matters in a long-running
   worker). Exact, deterministic counts that match OpenAI billing and feed Phase 3's prompt budget.
   Per-encoding import (`gpt-tokenizer/encoding/cl100k_base`) pulls in only the cl100k ranks. (WASM
   `@dqbd/tiktoken` is faster on huge batches, but our bottleneck is the OpenAI round-trip, not
   tokenization — the speed we'd buy is on a dimension we aren't bound on, at the cost of a leak risk.)

---

## 3. Schema delta — exactly one new table

No changes to `documents` or `chunks` (both already exist with RLS from Phase 1). One table added,
plus a one-line comment correction on `documents.content_hash` (§2.3).

```ts
// schema.ts — bytea needs a customType (drizzle pg-core has no built-in bytea column).
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

// document_blobs — FR-005. Holds the raw uploaded file between upload (202) and the
// worker parsing it. Separate table so status/list reads of `documents` stay lean.
// restaurant_id is DENORMALIZED so the same simple `tenant_isolation` RLS policy applies
// here too — making the privileged claim UPDATE the ONLY cross-tenant op in the pipeline.
export const documentBlobs = pgTable("document_blobs", {
  documentId:   uuid("document_id").primaryKey().references(() => documents.id, { onDelete: "cascade" }),
  restaurantId: uuid("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
  bytes:        bytea("bytes").notNull(),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Migration `0003`: drizzle-kit generates the `CREATE TABLE`; we **hand-add** the RLS statements to the
generated SQL exactly as migration 0001 did for the other six tables —

```sql
ALTER TABLE "document_blobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_blobs" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "document_blobs"
  USING      ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);
```

Grants are automatic: migration 0002's `ALTER DEFAULT PRIVILEGES … TO reg_app` means any table `reg`
creates in a later migration auto-grants CRUD to `reg_app`. Nothing else to grant.

---

## 4. Data flow A — upload (`POST /api/documents`, synchronous, fast)

```
POST /api/documents   cookie: sid=…   Content-Type: multipart/form-data   fields: file, title?
  └─ requireSession + requireRole("manager")        → 401 / 403
  └─ req.formData(): file (required), title (optional, Zod, defaults to filename)
  └─ validate file: mime === "application/pdf", size ≤ 10 MB  → 400 VALIDATION_ERROR
  └─ bytes = Buffer.from(await file.arrayBuffer());  contentHash = sha256(bytes)
  └─ withTenant(restaurant.id):
       INSERT INTO documents (…, status='pending', source_type='pdf', content_hash, uploaded_by)
       ON CONFLICT (restaurant_id, content_hash) DO NOTHING RETURNING id
         ├─ row returned (new):  INSERT document_blobs(document_id, restaurant_id, bytes)
         │                        → 202 { documentId, status: "pending" }
         └─ no row (duplicate):  SELECT existing doc by (restaurant_id, content_hash)
                                  if status='failed' → UPDATE status='pending' (reuse kept blob)
                                  → 200 { documentId, status }
```

- The `documents` insert and the `document_blobs` insert are one `withTenant` transaction — atomic; a
  document never exists without its bytes (until the worker drops them on success).
- Tenancy and `uploaded_by` come from the session, never the request (api.md §1). No `restaurant_id`
  input exists on this route.
- `ON CONFLICT … DO NOTHING RETURNING` makes the dedup branch explicit and race-safe (no reliance on
  catching a 23505), mirroring how `register` ultimately leans on the unique constraint.

---

## 5. Data flow B — the worker (asynchronous, can be slow)

Two files: the loop (`src/worker/index.ts`) and the per-job orchestrator
(`src/lib/ingest/process-document.ts`, testable without a loop).

```
loop (poll ~2s):
  1. reclaimStale()  [privileged]   UPDATE documents SET status='pending'
                                     WHERE status='processing' AND updated_at < now() - interval '5 min'
  2. claim()         [privileged]   UPDATE documents SET status='processing', updated_at=now()
                                     WHERE id = (SELECT id FROM documents WHERE status='pending'
                                                 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
                                     RETURNING id, restaurant_id, title, source_type
         └─ no row → sleep, continue
         └─ claimed job → processDocument(job):
  3. read blob   withTenant(rid) [reg_app]   SELECT bytes FROM document_blobs WHERE document_id=$1
  4. parse       (in memory, no DB conn)      parse(bytes, source_type) → text         [unpdf]
  5. chunk       (pure)                        chunk(text) → {text, tokenCount, idx}[]  [gpt-tokenizer]
  6. embed       (network, no DB conn)         embed(texts) → { vectors, usageTokens }  [OpenAI SDK]
  7. persist     withTenant(rid) [reg_app] — ONE tx, atomic:
                   INSERT chunks (all)         (restaurant_id = rid on every row)
                   INSERT usage_events         (kind='embedding', input_tokens=usageTokens, cost_usd)
                   DELETE document_blobs        (drop bytes — success only)
                   UPDATE documents status='done', updated_at=now()
  on ANY error in 3–7:
                 withTenant(rid) UPDATE documents status='failed', error=<message>, updated_at=now()
                 (blob is KEPT — a re-upload retry reuses it)
```

### Why two connections / two roles (the crux)
`documents`, `chunks`, `document_blobs`, `usage_events` all carry `FORCE ROW LEVEL SECURITY` keyed on
the `app.restaurant_id` GUC. The poller scans **across all tenants** for `status='pending'` — it has
no single tenant, so as `reg_app` with the GUC unset, `current_setting('app.restaurant_id', true)` is
NULL and the claim query returns **zero rows**. Scheduling is inherently cross-tenant; the work is
tenant-scoped. So:

- The worker opens a **privileged pool** from a new `WORKER_DATABASE_URL` used for *only* `reclaimStale()`
  and `claim()`. In dev this points at the existing `reg` superuser (bypasses RLS → sees all pending
  jobs) — **zero new infra**. Naming the env seam now means **Phase 8** can point it at a
  least-privilege `reg_worker` (`NOSUPERUSER … BYPASSRLS`, granted only `SELECT/UPDATE` on `documents`)
  with **no code change** — same pattern as the already-documented "`reg_app` dev password → infra in
  Phase 8" gap.
- All tenant work (steps 3, 7, and the failure update) uses the existing `reg_app` pool via
  `withTenant(rid)`, under enforced RLS — so the `WITH CHECK` on every `chunks` insert validates that
  `restaurant_id = rid`. The denormalized `restaurant_id` on `document_blobs` (§3) keeps the blob read
  under the same policy, leaving the claim `UPDATE` as the *only* cross-tenant operation in the system.

### Robustness
- **Status flip is the lock.** Once a row is `processing` no other worker re-claims it; `SKIP LOCKED`
  prevents collisions if more than one worker runs (MVP runs one — the design just doesn't preclude two).
- **No long transaction.** Parse/embed happen with no DB connection checked out; the two DB
  transactions (read blob; persist) are short.
- **Crash recovery.** A worker that dies mid-job leaves a row in `processing`; `reclaimStale()`
  returns it to `pending` after 5 minutes. (The claim sets `updated_at=now()`, so the timeout measures
  from claim time.)
- **One bad document never kills the loop** — `processDocument` errors are caught per-job and recorded.

---

## 6. Chunking — deterministic (FR-006), **yours to write**

Per `docs/rag.md §1`, a pure function in `src/lib/ingest/chunk.ts`:

```ts
type Chunk = { text: string; tokenCount: number; chunkIndex: number };
function chunk(raw: string): Chunk[];   // pure: (normalized text, TARGET=500, OVERLAP=75) → chunks
```

- **Normalize deterministically** (collapse runs of whitespace, normalize newlines, trim) so the same
  document text always yields the same input — this is what makes the raw-bytes content-hash and the
  chunk output consistent.
- **Split on natural boundaries first** (blank-line paragraphs → lines/list items), then **pack** units
  into chunks up to ~500 tokens, carrying ~75 tokens (~15%) of overlap from the end of one chunk into
  the start of the next.
- **Edge case:** a single boundary unit larger than the target (e.g., one huge paragraph) is
  hard-split by token windows (encode → slice → decode via gpt-tokenizer) so no chunk exceeds the
  target or the model's 8191-token input cap.
- **Pure & deterministic:** no clock, no randomness, no I/O — `chunk(x)` always returns the same array.

Per the AI-usage discipline (CLAUDE.md), **David writes the packing/overlap logic and explains it
back**; I scaffold the `Chunk` type, the normalization helper signature, and the determinism tests
around it. Chunking is core retrieval-quality surface — not a black box.

---

## 7. Module boundaries (small, single-purpose units)

| File | Purpose | Author |
|---|---|---|
| `schema.ts` | add `document_blobs` (+ `bytea` customType); fix `content_hash` comment | scaffold |
| `drizzle/0003_*.sql` | `document_blobs` DDL + RLS enable/force/policy (hand-added) | David (policy) |
| `src/lib/ingest/parse.ts` | `parse(bytes, sourceType) → text`; registry keyed by `sourceType` (only `pdf` now, via `unpdf`) | scaffold |
| `src/lib/ingest/chunk.ts` | `chunk(text) → Chunk[]` — deterministic packing | **David** |
| `src/lib/ai/embeddings.ts` | `embed(texts) → { vectors, usageTokens }`; `server-only`; OpenAI SDK + price constant | scaffold |
| `src/lib/ingest/claim.ts` | privileged pool + `claim()` / `reclaimStale()` (own `WORKER_DATABASE_URL` pool) | scaffold |
| `src/lib/ingest/process-document.ts` | orchestrate ONE claimed doc (read blob → parse → chunk → embed → persist / fail) | scaffold |
| `src/worker/index.ts` | the polling loop; graceful per-job error handling; structured logs | scaffold |
| `src/app/api/documents/route.ts` | `POST` upload (202/200) + `GET` list (cursor) | scaffold |
| `src/app/api/documents/[id]/route.ts` | `GET` status `{ id, title, status, error, chunkCount }` | scaffold |

New dependencies: `unpdf` (PDF→text, zero native deps), `gpt-tokenizer` (cl100k), `openai`
(embeddings), and `tsx` (devDep — runs the worker via `npm run worker`).

### Status endpoints (api.md §2.2 contract)
- `GET /api/documents/:id` — `requireRole("manager")`; `withTenant(rid)` select by id; RLS makes
  another tenant's id return no row → `404` (also the correct anti-enumeration behavior). `chunkCount`
  is populated (a `count(chunks)` for the doc) when `status='done'`, else `null`.
- `GET /api/documents` — `requireRole("manager")`; `withTenant(rid)` list ordered by `created_at DESC`,
  cursor pagination → `{ items: DocumentStatus[], nextCursor }`.

### Three small calls made in brainstorming (recorded, not re-litigated)
- **Claim role:** reuse `reg` superuser via `WORKER_DATABASE_URL` in dev; `reg_worker` is Phase 8 hardening.
- **Embeddings via the OpenAI SDK** now; the Vercel AI SDK enters in Phase 3 for generation/streaming.
- **Worker dev runtime:** `npm run worker` in a second terminal alongside `npm run dev`; a Docker
  Compose worker service is deferred to Phase 8.

---

## 8. Error handling & failure modes

| Situation | Handling | Result |
|---|---|---|
| Not authenticated / wrong role | guard | `401` / `403` envelope |
| Missing file / wrong mime / > 10 MB | upload validation | `400 VALIDATION_ERROR`, never reaches the worker |
| Corrupt/unparseable PDF, empty extracted text | caught in `processDocument` | `status='failed'`, readable `error`, **blob kept** |
| Embedding API failure / timeout | caught | `status='failed'` + error; no partial chunks (persist is atomic) |
| Worker crash mid-job | `reclaimStale()` after 5 min | row returns to `pending`, reprocessed |
| Duplicate upload | unique constraint + ON CONFLICT | existing doc returned (`200`); `failed` → reset to `pending` |

All API errors use the locked envelope (`api.md §1`). The worker logs structured job events
(`{ jobId, restaurantId, event, ms }`); **bytes, extracted text, and secrets are never logged**
(FR-025, and the secrets-server-side-only constraint).

---

## 9. Testing — definition-of-done is these passing

Written with vitest, run against the Docker Postgres (same harness as Phase 1).

- **Unit**
  - `chunk`: determinism (`chunk(x)` deep-equals `chunk(x)`); never exceeds target tokens; an
    oversized single unit is split; overlap is present between adjacent chunks.
  - `parse`: a fixture PDF → expected text; a non-PDF / corrupt buffer → throws (→ caller marks failed).
  - `embeddings`: with a **stubbed** OpenAI client — returns one 1536-d vector per input and surfaces
    `usageTokens`; never imported into client code (server-only guard).
- **Integration** (the real proof)
  - upload PDF (owner/manager) → `202` + `documents(pending)` + `document_blobs` row exists.
  - run `processDocument` once → `chunks` exist (count = `chunkCount`), each scoped to the tenant,
    `status='done'`, blob **dropped**, one `usage_events` row written.
  - **dedup:** re-upload identical bytes → `200`, **no new chunks**, no second `documents` row.
  - **failed path:** corrupt bytes → `status='failed'` + `error`, blob **kept**; then a re-upload
    flips it back to `pending`.
  - **isolation (FR-004/FR-010 backstop):** seed restaurants A and B; ingest a doc for A; under
    `withTenant(B.id)` neither A's `documents` nor A's `chunks` are visible; the claim UPDATE on the
    privileged pool is the only place that sees across tenants.
  - **guards:** a `trainee` hitting `POST /api/documents` → `403`; another tenant's doc id on
    `GET /api/documents/:id` → `404`.

`tsc --noEmit` clean and `next build` green are part of done.

---

## 10. Out of scope / known gaps (deliberate)

- **DOCX / text ingestion** — Stretch (FR-005). Parser is structured for it; only `pdf` registered now.
- **`reg_worker` least-privilege role** — Phase 8. Dev reuses `reg` via `WORKER_DATABASE_URL`; the env
  seam exists so prod hardens with no code change.
- **Docker Compose worker service** — Phase 8 (deploy). Dev runs the worker as a local process.
- **Per-tenant upload rate limiting / quotas** — FR-026, Phase 7.
- **Vercel AI SDK** — arrives in Phase 3 (generation/streaming); embeddings use the OpenAI SDK here.
- **Retrieval / Q&A** — Phase 3. Phase 2 stops at "tenant-scoped chunks exist and are embedded."
- **Multiple concurrent workers / pg-boss** — not until polling actually hurts (architecture §6).

---

## 11. Definition of done

Migration `0003` applies cleanly; `POST /api/documents` accepts a PDF from an owner/manager and
returns `202` with a `pending` job (or `200` for a dup); the worker claims it via
`FOR UPDATE SKIP LOCKED`, parses → deterministically chunks → embeds → writes tenant-scoped `chunks`
with a `usage_events` row, drops the blob, and marks `done` (or `failed` + error on a bad file);
status is visible via `GET /api/documents/:id` and `GET /api/documents`; re-uploading the same file
creates no duplicate chunks; the isolation test proves another tenant sees none of it; `tsc` is clean
and `next build` is green. Then Phase 2 is "runs, tested, and David can explain it" — specifically the
deterministic chunker and the two-role claim/work split.
