# Phase 2 — Document Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner/manager uploads a PDF; a background worker parses → deterministically chunks → embeds it; the resulting tenant-scoped `chunks` become queryable, with job status visible end-to-end and re-uploads de-duplicated.

**Architecture:** `POST /api/documents` stores the file bytes in a `document_blobs` table and returns a `pending` job (`202`). A long-running polling worker claims one job in a tiny *privileged* (RLS-bypassing) transaction by flipping its status to `processing`, then does parse/chunk/embed/write in a *separate* `withTenant` transaction as `reg_app` under enforced RLS. The status flip is the lock — no DB lock or connection is held across the OpenAI round-trip. Spec: `docs/superpowers/specs/2026-05-31-phase-2-document-ingestion-design.md`.

**Tech Stack:** Next.js 16 Route Handlers, Drizzle + `pg`, Postgres 16 + pgvector (RLS), `unpdf` (PDF→text), `gpt-tokenizer` (cl100k_base), `openai` SDK (`text-embedding-3-small`, 1536d), `tsx` (worker runtime), vitest.

**Prerequisites:** Docker Postgres running (`docker compose up -d`), `.env` populated (Task 1 adds two keys). Tests run serially against that DB (`vitest.config.ts` sets `fileParallelism:false`).

---

## File map

| File | Responsibility |
|---|---|
| `schema.ts` (modify) | add `bytea` customType + `documentBlobs`; fix `content_hash` comment |
| `drizzle/0003_*.sql` (generate+edit) | `document_blobs` DDL + RLS enable/force/policy |
| `tsconfig.worker.json` (create) | worker-scoped tsconfig aliasing `server-only` → stub, `@/*` → src |
| `src/lib/ingest/parse.ts` (create) | `parse(bytes, sourceType) → text`; PDF via `unpdf` |
| `src/lib/ingest/chunk.ts` (create) | `chunk(text) → Chunk[]` — deterministic; **David owns** |
| `src/lib/ai/embeddings.ts` (create) | `embed(texts) → {vectors, usageTokens}` + cost; server-only |
| `src/lib/ingest/claim.ts` (create) | privileged pool + `claimNextDocument()` / `reclaimStaleDocuments()` |
| `src/lib/ingest/process-document.ts` (create) | orchestrate one claimed doc (read blob→parse→chunk→embed→persist/fail) |
| `src/worker/index.ts` (create) | `runOnce()` + `runForever()` loop |
| `src/worker/main.ts` (create) | entrypoint (`dotenv` + `runForever()`) |
| `src/app/api/documents/route.ts` (create) | `POST` upload + `GET` list |
| `src/app/api/documents/[id]/route.ts` (create) | `GET` status |
| `test/helpers/pdf.ts` (create) | `makeMinimalPdf(text)` — valid PDF fixture builder |
| `test/helpers/auth.ts` (create) | `registerOwner()` / `makeUserCookie()` |

---

## Task 1: Dependencies, env seam, worker tsconfig

**Files:**
- Modify: `package.json` (deps + scripts)
- Modify: `.env`, `.env.example`
- Create: `tsconfig.worker.json`

- [ ] **Step 1: Install dependencies**

Run:
```bash
npm i unpdf gpt-tokenizer openai
npm i -D tsx
```
Expected: installs succeed; `unpdf`, `gpt-tokenizer`, `openai` in `dependencies`, `tsx` in `devDependencies`.

- [ ] **Step 2: Add worker scripts to `package.json`**

Add to the `"scripts"` block:
```json
    "worker": "tsx --tsconfig tsconfig.worker.json src/worker/main.ts",
    "worker:dev": "tsx watch --tsconfig tsconfig.worker.json src/worker/main.ts",
```

- [ ] **Step 3: Create `tsconfig.worker.json`**

The worker runs under plain Node (`tsx`), where the bare `server-only` import in `db.ts` does not resolve (Next provides it virtually). This worker-scoped tsconfig aliases it to the existing empty stub — exactly as `vitest.config.ts` does — and keeps the `@/*` alias. (Verified: `tsx --tsconfig` resolves these `paths`.)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"],
      "server-only": ["./test/stubs/server-only.ts"]
    }
  }
}
```

- [ ] **Step 4: Add env keys to `.env.example`**

Append:
```bash
# WORKER: the ingestion poller claims jobs ACROSS tenants, so it needs a role that
# bypasses RLS. In dev that's the reg superuser. Phase 8 swaps this for a least-priv
# reg_worker (NOSUPERUSER ... BYPASSRLS) with NO code change — only this URL changes.
WORKER_DATABASE_URL=postgres://reg:reg_dev_pw@localhost:5432/reg_ai
# OpenAI key — server-side only, never logged, never in client code.
OPENAI_API_KEY=sk-...
```

- [ ] **Step 5: Add the same keys to `.env`** (real values for dev — the `reg` URL matches `MIGRATION_DATABASE_URL`; use a real `OPENAI_API_KEY`, or `test-key` if only running tests that mock OpenAI).

- [ ] **Step 6: Verify the toolchain compiles**

Run: `npx tsc --noEmit`
Expected: PASS (no new files reference missing modules yet).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .env.example tsconfig.worker.json
git commit -m "Phase 2: deps (unpdf, gpt-tokenizer, openai, tsx), worker env seam + tsconfig"
```

---

## Task 2: Schema — `document_blobs` table + migration 0003 (RLS)

**Files:**
- Modify: `schema.ts`
- Create (generated, then edited): `drizzle/0003_*.sql`
- Test: `test/lib/db.documentBlobs.test.ts`

- [ ] **Step 1: Write the failing RLS test**

`test/lib/db.documentBlobs.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { restaurants, documents, documentBlobs } from "@/db/schema";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

async function seedDocWithBlob(name: string) {
  const [r] = await db.insert(restaurants).values({ name }).returning();
  track(r.id);
  return withTenant(r.id, async (tx) => {
    const [doc] = await tx.insert(documents).values({
      restaurantId: r.id, title: `${name} doc`, sourceType: "pdf", contentHash: `${name}-hash`,
    }).returning();
    await tx.insert(documentBlobs).values({
      documentId: doc.id, restaurantId: r.id, bytes: Buffer.from(`${name}-bytes`),
    });
    return { restaurant: r, doc };
  });
}

describe("document_blobs + RLS", () => {
  it("scopes blob reads to the GUC tenant", async () => {
    const a = await seedDocWithBlob("BLOBA");
    const b = await seedDocWithBlob("BLOBB");

    const aBlobs = await withTenant(a.restaurant.id, (tx) => tx.select().from(documentBlobs));
    expect(aBlobs.map((x) => x.documentId)).toEqual([a.doc.id]);

    const leak = await withTenant(a.restaurant.id, (tx) =>
      tx.select().from(documentBlobs).where(eq(documentBlobs.documentId, b.doc.id)));
    expect(leak).toHaveLength(0);
  });

  it("round-trips bytea content", async () => {
    const a = await seedDocWithBlob("BLOBC");
    const [row] = await withTenant(a.restaurant.id, (tx) =>
      tx.select().from(documentBlobs).where(eq(documentBlobs.documentId, a.doc.id)));
    expect(Buffer.isBuffer(row.bytes)).toBe(true);
    expect(row.bytes.toString()).toBe("BLOBC-bytes");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- db.documentBlobs`
Expected: FAIL — `documentBlobs` is not exported from schema (TS/import error).

- [ ] **Step 3: Add `documentBlobs` to `schema.ts`**

Add `customType` to the existing `drizzle-orm/pg-core` import, and insert this block right after the `chunks` table definition:
```ts
import { customType } from "drizzle-orm/pg-core"; // add to existing pg-core import

// bytea column type (drizzle pg-core has no built-in bytea). node-postgres maps
// bytea <-> Buffer natively, so no toDriver/fromDriver is needed.
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

// ---- document_blobs — FR-005 ------------------------------------------------
// Raw uploaded file, held between upload (202) and the worker parsing it. Separate
// table so the hot status/list reads of `documents` never drag MB of binary.
// restaurant_id is DENORMALIZED so the same tenant_isolation RLS policy applies here,
// making the privileged claim UPDATE the ONLY cross-tenant op in the pipeline.
// Dropped on successful processing; kept on failure so a re-upload retry reuses it.
export const documentBlobs = pgTable("document_blobs", {
  documentId:   uuid("document_id").primaryKey().references(() => documents.id, { onDelete: "cascade" }),
  restaurantId: uuid("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
  bytes:        bytea("bytes").notNull(),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Also fix the `documents.contentHash` comment (line ~108) from:
```ts
    contentHash: text("content_hash").notNull(), // SHA-256 over normalized text
```
to:
```ts
    contentHash: text("content_hash").notNull(), // SHA-256 over raw uploaded file bytes (computed at upload, pre-parse — see Phase 2 spec §2.3)
```

- [ ] **Step 4: Generate migration 0003**

Run: `npm run db:generate`
Expected: a new `drizzle/0003_<name>.sql` is created containing `CREATE TABLE "document_blobs" ( ... "bytes" bytea NOT NULL ... )`. Note the exact filename.

- [ ] **Step 5: Hand-add RLS to the generated `drizzle/0003_<name>.sql`**

drizzle-kit does NOT emit RLS. Append these statements to the end of the generated file (mirroring migration 0001), each separated by `--> statement-breakpoint`:
```sql
--> statement-breakpoint
ALTER TABLE "document_blobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_blobs" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_blobs"
  USING      ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);
```
(Grants are automatic — migration 0002's `ALTER DEFAULT PRIVILEGES ... TO reg_app` covers tables `reg` creates later.)

- [ ] **Step 6: Apply the migration**

Run: `npm run db:migrate`
Expected: applies `0003` cleanly; no errors.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test -- db.documentBlobs`
Expected: PASS (both cases).

- [ ] **Step 8: Commit**

```bash
git add schema.ts drizzle/ test/lib/db.documentBlobs.test.ts
git commit -m "Phase 2: document_blobs table + RLS (migration 0003); content_hash comment fix"
```

---

## Task 3: Deterministic chunker (`chunk.ts`) — **David owns this**

> **AI-usage discipline (CLAUDE.md):** David writes the packing/overlap logic and explains it back. The implementation in Step 3 is the **reference to check against / tune from**, not to blindly paste. The tests in Step 1 are the contract it must satisfy.

**Files:**
- Create: `src/lib/ingest/chunk.ts`
- Test: `test/lib/chunk.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/lib/chunk.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { encode } from "gpt-tokenizer/encoding/cl100k_base";
import { chunk, normalize, TARGET_TOKENS, OVERLAP_TOKENS } from "@/lib/ingest/chunk";

const big = (paras: number) =>
  Array.from({ length: paras }, (_, i) =>
    `Paragraph ${i}. ` + "word ".repeat(120)).join("\n\n");

describe("chunk()", () => {
  it("is deterministic — same input yields identical chunks", () => {
    const text = big(10);
    expect(chunk(text)).toEqual(chunk(text));
  });

  it("indexes chunks sequentially from 0", () => {
    const c = chunk(big(10));
    expect(c.map((x) => x.chunkIndex)).toEqual(c.map((_, i) => i));
  });

  it("keeps every chunk within the token bound and reports accurate token_count", () => {
    for (const c of chunk(big(20))) {
      expect(c.tokenCount).toBe(encode(c.text).length);
      expect(c.tokenCount).toBeLessThanOrEqual(TARGET_TOKENS + OVERLAP_TOKENS);
      expect(c.tokenCount).toBeGreaterThan(0);
    }
  });

  it("overlaps consecutive chunks (the tail of one appears at the head of the next)", () => {
    const c = chunk(big(20));
    expect(c.length).toBeGreaterThanOrEqual(2);
    // chunk[n+1] begins with text carried from the end of chunk[n].
    expect(c[0].text).toContain(c[1].text.slice(0, 20));
  });

  it("hard-splits a single oversized unit into multiple bounded chunks", () => {
    const oneHugeParagraph = "word ".repeat(2000); // ~2000 tokens, no blank lines
    const c = chunk(oneHugeParagraph);
    expect(c.length).toBeGreaterThan(1);
    for (const x of c) expect(x.tokenCount).toBeLessThanOrEqual(TARGET_TOKENS + OVERLAP_TOKENS);
  });

  it("returns [] for empty / whitespace-only input", () => {
    expect(chunk("   \n\n  ")).toEqual([]);
  });

  it("normalize collapses whitespace and newlines deterministically", () => {
    expect(normalize("a  \t b\r\n\r\n\r\nc")).toBe("a b\n\nc");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- chunk`
Expected: FAIL — `@/lib/ingest/chunk` does not exist.

- [ ] **Step 3: Write the chunker** (reference implementation — David: write your own to satisfy the tests, then compare)

`src/lib/ingest/chunk.ts`:
```ts
// Deterministic chunker (FR-006). Pure function of (normalized text, fixed params):
// same text in -> identical chunks out. That determinism is what makes the raw-bytes
// content-hash dedup meaningful. Tuned against the eval set in Phase 3.
import { encode, decode } from "gpt-tokenizer/encoding/cl100k_base";

export const TARGET_TOKENS = 500;   // ~ a full dish description / SOP step with context
export const OVERLAP_TOKENS = 75;   // ~15% — keeps context across a boundary

export type Chunk = { text: string; tokenCount: number; chunkIndex: number };

// Deterministic normalization: \r\n -> \n, collapse intra-line whitespace, trim lines,
// collapse blank-line runs to a single blank line, trim ends.
export function normalize(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .split("\n").map((l) => l.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A boundary unit larger than the target is hard-split into token windows (<= TARGET),
// each overlapping the previous by OVERLAP — so no single unit can blow the budget.
function splitOversized(unit: string): string[] {
  const toks = encode(unit);
  if (toks.length <= TARGET_TOKENS) return [unit];
  const pieces: string[] = [];
  const step = TARGET_TOKENS - OVERLAP_TOKENS;
  for (let i = 0; i < toks.length; i += step) {
    pieces.push(decode(toks.slice(i, i + TARGET_TOKENS)));
    if (i + TARGET_TOKENS >= toks.length) break;
  }
  return pieces;
}

export function chunk(raw: string): Chunk[] {
  const text = normalize(raw);
  if (!text) return [];

  // Natural boundaries first: paragraphs (blank-line separated), each capped to <= TARGET.
  const units = text.split(/\n{2,}/).flatMap((p) => splitOversized(p));

  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let bufTokens = 0;

  const emit = () => {
    if (!buf.length) return;
    const body = buf.join("\n\n");
    chunks.push({ text: body, tokenCount: encode(body).length, chunkIndex: chunks.length });
  };

  for (const unit of units) {
    const t = encode(unit).length;
    if (bufTokens > 0 && bufTokens + t > TARGET_TOKENS) {
      const prevBody = buf.join("\n\n");
      emit();
      // Carry the last OVERLAP_TOKENS of the emitted chunk as the next chunk's prefix.
      // BPE decode concatenates token strings, so decode(tokens.slice(-k)) is exactly
      // the text suffix for those tokens -> guaranteed overlap, deterministic.
      const prevTokens = encode(prevBody);
      const tail = prevTokens.slice(Math.max(0, prevTokens.length - OVERLAP_TOKENS));
      const overlapText = decode(tail);
      buf = [overlapText];
      bufTokens = tail.length;
    }
    buf.push(unit);
    bufTokens += t;
  }
  emit();
  return chunks;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- chunk`
Expected: PASS (all 7 cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ingest/chunk.ts test/lib/chunk.test.ts
git commit -m "Phase 2: deterministic chunker (FR-006) — natural boundaries + token overlap"
```

---

## Task 4: PDF parser (`parse.ts`)

**Files:**
- Create: `src/lib/ingest/parse.ts`
- Create: `test/helpers/pdf.ts`
- Test: `test/lib/parse.test.ts`

- [ ] **Step 1: Create the PDF fixture builder**

A self-contained valid single-page PDF with extractable text — no binary committed, correct xref offsets so `unpdf` (pdf.js) parses without recovery. `test/helpers/pdf.ts`:
```ts
// Builds a minimal valid single-page PDF containing one line of ASCII text that
// pdf.js (unpdf) extracts. Offsets are computed (latin1 = 1 byte/char) so the xref
// is correct. ASCII text only.
export function makeMinimalPdf(text: string): Buffer {
  const safe = text.replace(/([()\\])/g, "\\$1");
  const content = `BT /F1 24 Tf 72 700 Td (${safe}) Tj ET`;
  const objects: Record<number, string> = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    4: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    5: `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  };
  const header = "%PDF-1.4\n";
  let body = "";
  const offsets: number[] = [];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = header.length + body.length;
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = header.length + body.length;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(header + body + xref + trailer, "latin1");
}
```

- [ ] **Step 2: Write the failing tests**

`test/lib/parse.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parse } from "@/lib/ingest/parse";
import { makeMinimalPdf } from "../helpers/pdf";

describe("parse()", () => {
  it("extracts text from a PDF buffer", async () => {
    const buf = makeMinimalPdf("REG AI ingestion test document");
    const text = await parse(buf, "pdf");
    expect(text).toContain("REG AI ingestion test document");
  });

  it("throws on a non-PDF buffer (so the caller marks the job failed)", async () => {
    await expect(parse(Buffer.from("this is not a pdf"), "pdf")).rejects.toThrow();
  });

  it("throws on an unsupported source type", async () => {
    await expect(parse(Buffer.from("x"), "docx")).rejects.toThrow(/unsupported/i);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -- parse`
Expected: FAIL — `@/lib/ingest/parse` does not exist.

- [ ] **Step 4: Write the parser**

`src/lib/ingest/parse.ts`:
```ts
// bytes -> plain text, dispatched by source type. PDF only for the MVP slice (FR-005);
// the registry shape means DOCX/text are a later registration, not a rewrite.
import { extractText, getDocumentProxy } from "unpdf";

export type SourceType = "pdf" | "docx" | "text";

async function parsePdf(bytes: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

const PARSERS: Partial<Record<SourceType, (b: Buffer) => Promise<string>>> = {
  pdf: parsePdf,
};

export async function parse(bytes: Buffer, sourceType: SourceType): Promise<string> {
  const parser = PARSERS[sourceType];
  if (!parser) throw new Error(`unsupported source type: ${sourceType}`);
  return parser(bytes);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- parse`
Expected: PASS (all 3 cases).

- [ ] **Step 6: Commit**

```bash
git add src/lib/ingest/parse.ts test/helpers/pdf.ts test/lib/parse.test.ts
git commit -m "Phase 2: PDF parser via unpdf + minimal-PDF test fixture builder"
```

---

## Task 5: Embeddings module (`embeddings.ts`)

**Files:**
- Create: `src/lib/ai/embeddings.ts`
- Test: `test/lib/embeddings.test.ts`

- [ ] **Step 1: Write the failing test** (OpenAI client mocked — no network, no real key)

`test/lib/embeddings.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("openai", () => ({ default: vi.fn(() => ({ embeddings: { create } })) }));

beforeEach(() => {
  create.mockReset();
  process.env.OPENAI_API_KEY = "test-key";
});

describe("embed()", () => {
  it("returns one vector per input and surfaces usage tokens", async () => {
    create.mockResolvedValue({
      data: [{ embedding: Array(1536).fill(0.1) }, { embedding: Array(1536).fill(0.2) }],
      usage: { total_tokens: 42 },
    });
    const { embed } = await import("@/lib/ai/embeddings");
    const res = await embed(["alpha", "beta"]);
    expect(res.vectors).toHaveLength(2);
    expect(res.vectors[0]).toHaveLength(1536);
    expect(res.usageTokens).toBe(42);
    expect(create).toHaveBeenCalledWith({ model: "text-embedding-3-small", input: ["alpha", "beta"] });
  });

  it("short-circuits empty input without calling OpenAI", async () => {
    const { embed } = await import("@/lib/ai/embeddings");
    const res = await embed([]);
    expect(res).toEqual({ vectors: [], usageTokens: 0 });
    expect(create).not.toHaveBeenCalled();
  });

  it("computes cost from the locked per-token price", async () => {
    const { embeddingCostUsd } = await import("@/lib/ai/embeddings");
    expect(embeddingCostUsd(1_000_000)).toBeCloseTo(0.02, 6);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- embeddings`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the embeddings module**

`src/lib/ai/embeddings.ts`:
```ts
// The single, swappable embedding boundary. server-only: the OpenAI key never reaches
// client code and is never logged. Model + dim are LOCKED (rag.md §2) — changing them is
// a migration, not a flag.
import "server-only";
import OpenAI from "openai";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIM = 1536; // matches vector(1536) in schema
const COST_PER_TOKEN_USD = 0.02 / 1_000_000; // text-embedding-3-small: $0.02 / 1M tokens

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set (server-only).");
  client = new OpenAI({ apiKey });
  return client;
}

export function embeddingCostUsd(tokens: number): number {
  return tokens * COST_PER_TOKEN_USD;
}

export async function embed(texts: string[]): Promise<{ vectors: number[][]; usageTokens: number }> {
  if (texts.length === 0) return { vectors: [], usageTokens: 0 };
  const res = await getClient().embeddings.create({ model: EMBEDDING_MODEL, input: texts });
  return { vectors: res.data.map((d) => d.embedding), usageTokens: res.usage.total_tokens };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- embeddings`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/embeddings.ts test/lib/embeddings.test.ts
git commit -m "Phase 2: embeddings module (text-embedding-3-small, 1536d) + cost (FR-007/FR-023)"
```

---

## Task 6: Privileged claim module (`claim.ts`)

**Files:**
- Create: `src/lib/ingest/claim.ts`
- Test: `test/lib/claim.test.ts`

- [ ] **Step 1: Write the failing test** (requires `WORKER_DATABASE_URL` in `.env`)

`test/lib/claim.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { restaurants, documents } from "@/db/schema";
import { claimNextDocument, reclaimStaleDocuments, claimPool } from "@/lib/ingest/claim";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

async function seedPendingDoc(name: string) {
  const [r] = await db.insert(restaurants).values({ name }).returning();
  track(r.id);
  const [doc] = await withTenant(r.id, (tx) =>
    tx.insert(documents).values({
      restaurantId: r.id, title: `${name} doc`, sourceType: "pdf", contentHash: `${name}-${crypto.randomUUID()}`,
    }).returning());
  return { restaurant: r, doc };
}

describe("claim (privileged, cross-tenant)", () => {
  it("claims a pending doc across tenants and flips it to processing", async () => {
    const { restaurant, doc } = await seedPendingDoc("CLAIM1");
    const job = await claimNextDocument();
    expect(job).not.toBeNull();
    // The poller sees pending jobs regardless of tenant GUC (RLS-bypassing role).
    expect(job!.restaurantId).toBe(restaurant.id);
    expect(job!.sourceType).toBe("pdf");

    const [after] = await withTenant(restaurant.id, (tx) =>
      tx.select({ status: documents.status }).from(documents).where(eq(documents.id, doc.id)));
    expect(after.status).toBe("processing");
  });

  it("returns null when nothing is pending", async () => {
    // claim everything currently pending, then expect null.
    while (await claimNextDocument()) { /* drain */ }
    expect(await claimNextDocument()).toBeNull();
  });

  it("reclaims a doc stuck in processing past the timeout", async () => {
    const { restaurant, doc } = await seedPendingDoc("CLAIM2");
    await claimNextDocument(); // -> processing
    // Backdate updated_at via the privileged pool to simulate a crashed worker.
    await claimPool.query(`UPDATE documents SET updated_at = now() - interval '10 minutes' WHERE id = $1`, [doc.id]);
    const reclaimed = await reclaimStaleDocuments();
    expect(reclaimed).toBeGreaterThanOrEqual(1);
    const [after] = await withTenant(restaurant.id, (tx) =>
      tx.select({ status: documents.status }).from(documents).where(eq(documents.id, doc.id)));
    expect(after.status).toBe("pending");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- claim`
Expected: FAIL — `@/lib/ingest/claim` does not exist.

- [ ] **Step 3: Write the claim module**

`src/lib/ingest/claim.ts`:
```ts
// The PRIVILEGED, cross-tenant scheduler half of the worker. Scheduling is inherently
// cross-tenant (the poller must see every tenant's pending jobs), so it uses a role that
// bypasses RLS (WORKER_DATABASE_URL = the reg superuser in dev; a least-priv reg_worker
// in prod, Phase 8). The status flip to 'processing' IS the lock — no long-held DB lock.
// All TENANT-SCOPED work (read blob, write chunks) happens elsewhere as reg_app + withTenant.
import "server-only";
import { Pool } from "pg";
import type { SourceType } from "@/lib/ingest/parse";

const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) {
  throw new Error("WORKER_DATABASE_URL is not set (server-only). Needs an RLS-bypassing role (dev: reg superuser).");
}

const globalForClaim = globalThis as unknown as { _workerPool?: Pool };
export const claimPool = globalForClaim._workerPool ?? new Pool({ connectionString, max: 4 });
if (process.env.NODE_ENV !== "production") globalForClaim._workerPool = claimPool;

export type ClaimedJob = {
  id: string;
  restaurantId: string;
  title: string;
  sourceType: SourceType;
  uploadedBy: string | null;
};

// Atomically claim ONE pending doc: SKIP LOCKED avoids worker collisions; the status
// flip means no other worker re-claims it. Returns null if nothing is pending.
export async function claimNextDocument(): Promise<ClaimedJob | null> {
  const { rows } = await claimPool.query<ClaimedJob>(
    `UPDATE documents SET status='processing', updated_at=now()
     WHERE id = (
       SELECT id FROM documents WHERE status='pending'
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
     )
     RETURNING id,
               restaurant_id AS "restaurantId",
               title,
               source_type   AS "sourceType",
               uploaded_by   AS "uploadedBy"`,
  );
  return rows[0] ?? null;
}

// Crash recovery: a doc left in 'processing' past the timeout returns to 'pending'.
export async function reclaimStaleDocuments(maxAgeMs = 5 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const { rowCount } = await claimPool.query(
    `UPDATE documents SET status='pending', updated_at=now()
     WHERE status='processing' AND updated_at < $1`,
    [cutoff],
  );
  return rowCount ?? 0;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- claim`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ingest/claim.ts test/lib/claim.test.ts
git commit -m "Phase 2: privileged claim + stale-reclaim (FOR UPDATE SKIP LOCKED) (FR-009)"
```

---

## Task 7: Process-document orchestrator (`process-document.ts`)

**Files:**
- Create: `src/lib/ingest/process-document.ts`
- Test: `test/lib/process-document.test.ts`

- [ ] **Step 1: Write the failing tests** (real parse/chunk; `embed` mocked → no OpenAI)

`test/lib/process-document.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { restaurants, documents, documentBlobs, chunks, usageEvents } from "@/db/schema";
import { track, cleanup } from "../helpers/db";
import { makeMinimalPdf } from "../helpers/pdf";

vi.mock("@/lib/ai/embeddings", () => ({
  EMBEDDING_MODEL: "text-embedding-3-small",
  EMBEDDING_DIM: 1536,
  embeddingCostUsd: (t: number) => t * (0.02 / 1_000_000),
  embed: vi.fn(async (texts: string[]) => ({
    vectors: texts.map(() => Array(1536).fill(0.01)),
    usageTokens: texts.length * 10,
  })),
}));

import { processDocument } from "@/lib/ingest/process-document";

afterEach(cleanup);

async function seedClaimedPdf(name: string, bytes: Buffer) {
  const [r] = await db.insert(restaurants).values({ name }).returning();
  track(r.id);
  const job = await withTenant(r.id, async (tx) => {
    const [doc] = await tx.insert(documents).values({
      restaurantId: r.id, title: `${name}`, sourceType: "pdf",
      contentHash: `${name}-${crypto.randomUUID()}`, status: "processing",
    }).returning();
    await tx.insert(documentBlobs).values({ documentId: doc.id, restaurantId: r.id, bytes });
    return { id: doc.id, restaurantId: r.id, title: doc.title, sourceType: "pdf" as const, uploadedBy: null };
  });
  return { restaurant: r, job };
}

describe("processDocument()", () => {
  it("parses, chunks, embeds, writes tenant-scoped chunks, drops the blob, marks done", async () => {
    const { restaurant, job } = await seedClaimedPdf("PROC1", makeMinimalPdf("Grounded answers require citations"));
    await processDocument(job);

    const rows = await withTenant(restaurant.id, async (tx) => ({
      doc: (await tx.select().from(documents).where(eq(documents.id, job.id)))[0],
      chunks: await tx.select().from(chunks).where(eq(chunks.documentId, job.id)),
      blobs: await tx.select().from(documentBlobs).where(eq(documentBlobs.documentId, job.id)),
      usage: await tx.select().from(usageEvents).where(eq(usageEvents.restaurantId, restaurant.id)),
    }));

    expect(rows.doc.status).toBe("done");
    expect(rows.chunks.length).toBeGreaterThan(0);
    expect(rows.chunks.every((c) => c.restaurantId === restaurant.id)).toBe(true);
    expect(rows.chunks[0].embedding).toHaveLength(1536);
    expect(rows.blobs).toHaveLength(0);                 // dropped on success
    expect(rows.usage.some((u) => u.kind === "embedding")).toBe(true);
  });

  it("marks the doc failed (and KEEPS the blob) on an unparseable file", async () => {
    const { restaurant, job } = await seedClaimedPdf("PROC2", Buffer.from("definitely not a pdf"));
    await processDocument(job);

    const { doc, blobs, chunkRows } = await withTenant(restaurant.id, async (tx) => ({
      doc: (await tx.select().from(documents).where(eq(documents.id, job.id)))[0],
      blobs: await tx.select().from(documentBlobs).where(eq(documentBlobs.documentId, job.id)),
      chunkRows: await tx.select().from(chunks).where(eq(chunks.documentId, job.id)),
    }));

    expect(doc.status).toBe("failed");
    expect(doc.error).toBeTruthy();
    expect(blobs).toHaveLength(1);                      // kept for retry
    expect(chunkRows).toHaveLength(0);                  // atomic: no partial chunks
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- process-document`
Expected: FAIL — `@/lib/ingest/process-document` does not exist.

- [ ] **Step 3: Write the orchestrator**

`src/lib/ingest/process-document.ts`:
```ts
// Processes ONE already-claimed document, fully tenant-scoped (reg_app + withTenant) so
// every write passes the RLS WITH CHECK. Network work (parse/embed) happens with NO DB
// connection held; the two DB transactions (read blob; persist) are short. On any failure
// the doc is marked 'failed' with the error and the blob is KEPT (a re-upload retries it).
import "server-only";
import { eq } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { documents, documentBlobs, chunks, usageEvents } from "@/db/schema";
import { parse } from "@/lib/ingest/parse";
import { chunk } from "@/lib/ingest/chunk";
import { embed, embeddingCostUsd, EMBEDDING_MODEL } from "@/lib/ai/embeddings";
import type { ClaimedJob } from "@/lib/ingest/claim";

const log = (event: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ event, ...fields })); // never logs bytes or text (FR-025)

export async function processDocument(job: ClaimedJob): Promise<void> {
  log("ingest.start", { jobId: job.id, restaurantId: job.restaurantId });
  try {
    // 1. Read the blob (short read tx), then release the connection for parse/embed.
    const [blob] = await withTenant(job.restaurantId, (tx) =>
      tx.select({ bytes: documentBlobs.bytes }).from(documentBlobs).where(eq(documentBlobs.documentId, job.id)));
    if (!blob) throw new Error("blob missing for document");

    // 2-3. Parse + deterministically chunk (no DB connection held).
    const text = await parse(blob.bytes, job.sourceType);
    const pieces = chunk(text);
    if (pieces.length === 0) throw new Error("no extractable text in document");

    // 4. Embed (network, no DB connection held).
    const { vectors, usageTokens } = await embed(pieces.map((p) => p.text));

    // 5. Persist atomically: chunks + usage_events + drop blob + mark done.
    await withTenant(job.restaurantId, async (tx) => {
      await tx.insert(chunks).values(pieces.map((p) => ({
        documentId: job.id,
        restaurantId: job.restaurantId,
        chunkIndex: p.chunkIndex,
        text: p.text,
        tokenCount: p.tokenCount,
        embedding: vectors[p.chunkIndex],
      })));
      await tx.insert(usageEvents).values({
        restaurantId: job.restaurantId,
        userId: job.uploadedBy,
        kind: "embedding",
        model: EMBEDDING_MODEL,
        inputTokens: usageTokens,
        outputTokens: 0,
        costUsd: embeddingCostUsd(usageTokens).toFixed(6),
      });
      await tx.delete(documentBlobs).where(eq(documentBlobs.documentId, job.id));
      await tx.update(documents).set({ status: "done", error: null }).where(eq(documents.id, job.id));
    });

    log("ingest.done", { jobId: job.id, chunks: pieces.length, tokens: usageTokens });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("ingest.failed", { jobId: job.id, error: message });
    // Mark failed; KEEP the blob so a re-upload can retry without re-uploading.
    await withTenant(job.restaurantId, (tx) =>
      tx.update(documents).set({ status: "failed", error: message.slice(0, 500) }).where(eq(documents.id, job.id)));
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- process-document`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ingest/process-document.ts test/lib/process-document.test.ts
git commit -m "Phase 2: process-document orchestrator — read blob -> parse -> chunk -> embed -> persist/fail (FR-006/007/009)"
```

---

## Task 8: Worker loop (`worker/index.ts` + `worker/main.ts`)

**Files:**
- Create: `src/worker/index.ts`
- Create: `src/worker/main.ts`
- Test: `test/worker/run-once.test.ts`

- [ ] **Step 1: Write the failing test** (wires claim → process; `embed` mocked)

`test/worker/run-once.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { restaurants, documents, documentBlobs } from "@/db/schema";
import { track, cleanup } from "../helpers/db";
import { makeMinimalPdf } from "../helpers/pdf";

vi.mock("@/lib/ai/embeddings", () => ({
  EMBEDDING_MODEL: "text-embedding-3-small",
  EMBEDDING_DIM: 1536,
  embeddingCostUsd: (t: number) => t * (0.02 / 1_000_000),
  embed: vi.fn(async (texts: string[]) => ({
    vectors: texts.map(() => Array(1536).fill(0.02)),
    usageTokens: texts.length * 5,
  })),
}));

import { runOnce } from "@/worker/index";

afterEach(cleanup);

describe("runOnce()", () => {
  it("claims + processes one pending doc and returns its id", async () => {
    const [r] = await db.insert(restaurants).values({ name: "RUN1" }).returning();
    track(r.id);
    const [doc] = await withTenant(r.id, async (tx) => {
      const [d] = await tx.insert(documents).values({
        restaurantId: r.id, title: "menu", sourceType: "pdf", contentHash: crypto.randomUUID(),
      }).returning();
      await tx.insert(documentBlobs).values({
        documentId: d.id, restaurantId: r.id, bytes: makeMinimalPdf("worker run-once test"),
      });
      return [d];
    });

    const processedId = await runOnce();
    expect(processedId).toBe(doc.id);
    const [after] = await withTenant(r.id, (tx) =>
      tx.select({ status: documents.status }).from(documents).where(eq(documents.id, doc.id)));
    expect(after.status).toBe("done");
  });

  it("returns null when there is nothing to do", async () => {
    const { claimNextDocument } = await import("@/lib/ingest/claim");
    while (await claimNextDocument()) { /* drain anything pending from other tests */ }
    expect(await runOnce()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- run-once`
Expected: FAIL — `@/worker/index` does not exist.

- [ ] **Step 3: Write the worker loop + entrypoint**

`src/worker/index.ts`:
```ts
// The long-running ingestion poller. One iteration = reclaim stale jobs, claim one
// pending doc, process it. The loop drains immediately when work exists and backs off
// when idle. runOnce() is exported so a single iteration can be tested without a loop.
import "server-only";
import { claimNextDocument, reclaimStaleDocuments } from "@/lib/ingest/claim";
import { processDocument } from "@/lib/ingest/process-document";

const POLL_INTERVAL_MS = 2000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runOnce(): Promise<string | null> {
  await reclaimStaleDocuments();
  const job = await claimNextDocument();
  if (!job) return null;
  await processDocument(job);
  return job.id;
}

export async function runForever(): Promise<void> {
  let running = true;
  const stop = () => { running = false; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(JSON.stringify({ event: "worker.start", pollMs: POLL_INTERVAL_MS }));

  while (running) {
    try {
      const id = await runOnce();
      if (!id) await sleep(POLL_INTERVAL_MS); // idle -> back off; work present -> drain
    } catch (err) {
      console.error(JSON.stringify({ event: "worker.tick_error", error: String(err) }));
      await sleep(POLL_INTERVAL_MS);
    }
  }
  console.log(JSON.stringify({ event: "worker.stop" }));
}
```

`src/worker/main.ts`:
```ts
// Entrypoint for `npm run worker` (tsx --tsconfig tsconfig.worker.json). tsx does not
// auto-load .env, so we load it here (like drizzle.config.ts and test/setup.ts do).
import "dotenv/config";
import { runForever } from "@/worker/index";

runForever().then(() => process.exit(0));
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- run-once`
Expected: PASS (both cases).

- [ ] **Step 5: Smoke-test the real worker process** (proves the `server-only`/tsx launch path)

Ensure `.env` has `WORKER_DATABASE_URL` and `OPENAI_API_KEY`, then run:
```bash
timeout 4 npm run worker; true
```
Expected: prints `{"event":"worker.start","pollMs":2000}` and idles (no `server-only` / module-not-found crash). If a real OpenAI key is set and a pending doc exists, it processes; otherwise it just polls.

- [ ] **Step 6: Commit**

```bash
git add src/worker/index.ts src/worker/main.ts test/worker/run-once.test.ts
git commit -m "Phase 2: ingestion worker loop (runOnce/runForever) + tsx entrypoint (FR-009)"
```

---

## Task 9: Upload + list routes (`POST` / `GET /api/documents`)

**Files:**
- Create: `src/app/api/documents/route.ts`
- Create: `test/helpers/auth.ts`
- Test: `test/api/documents.test.ts`

- [ ] **Step 1: Create the auth test helper**

`test/helpers/auth.ts`:
```ts
import { POST as register } from "@/app/api/auth/register/route";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { createSession } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { track } from "./db";

// Registers a fresh restaurant + owner; returns a ready-to-use cookie header value.
export async function registerOwner() {
  const email = `${crypto.randomUUID()}@t.test`;
  const res = await register(new Request("http://x/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ restaurantName: "T", email, password: "x".repeat(12) }),
  }));
  const json = await res.json();
  track(json.restaurant.id);
  return { cookie: `sid=${res.cookies.get("sid")!.value}`, restaurant: json.restaurant, user: json.user };
}

// Creates an extra user (any role) in an existing restaurant + a session cookie for it.
export async function makeUserCookie(restaurantId: string, role: "manager" | "trainee") {
  const [u] = await db.insert(users).values({
    restaurantId,
    email: `${crypto.randomUUID()}@t.test`,
    passwordHash: await hashPassword("x".repeat(12)),
    role,
  }).returning();
  const { token } = await createSession(u.id);
  return { cookie: `sid=${token}`, user: u };
}
```

- [ ] **Step 2: Write the failing tests**

`test/api/documents.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { documents, documentBlobs } from "@/db/schema";
import { POST, GET } from "@/app/api/documents/route";
import { registerOwner, makeUserCookie } from "../helpers/auth";
import { cleanup } from "../helpers/db";
import { makeMinimalPdf } from "../helpers/pdf";

afterEach(cleanup);

function uploadReq(cookie: string, bytes: Buffer, opts: { title?: string; type?: string; name?: string } = {}) {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(bytes)], opts.name ?? "menu.pdf", { type: opts.type ?? "application/pdf" }));
  if (opts.title) fd.append("title", opts.title);
  return new Request("http://x/api/documents", { method: "POST", headers: { cookie }, body: fd });
}

describe("POST /api/documents", () => {
  it("accepts a PDF from a manager-or-above and returns 202 pending + a blob row", async () => {
    const owner = await registerOwner();
    const res = await POST(uploadReq(owner.cookie, makeMinimalPdf("upload test")));
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.status).toBe("pending");

    const blobs = await withTenant(owner.restaurant.id, (tx) =>
      tx.select().from(documentBlobs).where(eq(documentBlobs.documentId, json.documentId)));
    expect(blobs).toHaveLength(1);
  });

  it("is idempotent: a byte-identical re-upload returns 200 with the same id, no duplicate row", async () => {
    const owner = await registerOwner();
    const bytes = makeMinimalPdf("dedup me");
    const first = await POST(uploadReq(owner.cookie, bytes));
    const a = await first.json();
    const second = await POST(uploadReq(owner.cookie, bytes));
    expect(second.status).toBe(200);
    const b = await second.json();
    expect(b.documentId).toBe(a.documentId);

    const docs = await withTenant(owner.restaurant.id, (tx) => tx.select().from(documents));
    expect(docs).toHaveLength(1);
  });

  it("rejects a trainee with 403", async () => {
    const owner = await registerOwner();
    const trainee = await makeUserCookie(owner.restaurant.id, "trainee");
    const res = await POST(uploadReq(trainee.cookie, makeMinimalPdf("nope")));
    expect(res.status).toBe(403);
  });

  it("rejects a non-PDF with 400", async () => {
    const owner = await registerOwner();
    const res = await POST(uploadReq(owner.cookie, Buffer.from("hi"), { type: "text/plain", name: "x.txt" }));
    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await POST(uploadReq("sid=bogus", makeMinimalPdf("x")));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/documents", () => {
  it("lists this tenant's documents (chunkCount null while pending)", async () => {
    const owner = await registerOwner();
    await POST(uploadReq(owner.cookie, makeMinimalPdf("list me")));
    const res = await GET(new Request("http://x/api/documents", { headers: { cookie: owner.cookie } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toHaveLength(1);
    expect(json.items[0].status).toBe("pending");
    expect(json.items[0].chunkCount).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -- api/documents`
Expected: FAIL — `@/app/api/documents/route` does not exist.

- [ ] **Step 4: Write the route**

`src/app/api/documents/route.ts`:
```ts
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { documents, documentBlobs, chunks } from "@/db/schema";
import { requireSession, hasRole } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const PAGE_SIZE = 20;

// POST /api/documents — owner|manager. multipart/form-data: file (PDF), title?.
export async function POST(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");

  let form: FormData;
  try { form = await req.formData(); }
  catch { return errorResponse("VALIDATION_ERROR", "Expected multipart/form-data"); }

  const file = form.get("file");
  if (!(file instanceof File)) return errorResponse("VALIDATION_ERROR", "Missing file");
  if (file.type !== "application/pdf") return errorResponse("VALIDATION_ERROR", "Only PDF is supported");
  if (file.size > MAX_BYTES) return errorResponse("VALIDATION_ERROR", "File exceeds the 10 MB limit");

  const titleRaw = form.get("title");
  const title = typeof titleRaw === "string" && titleRaw.trim() ? titleRaw.trim() : file.name;

  const bytes = Buffer.from(await file.arrayBuffer());
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const rid = session.restaurant.id;

  const result = await withTenant(rid, async (tx) => {
    const inserted = await tx.insert(documents).values({
      restaurantId: rid, title, sourceType: "pdf", contentHash, status: "pending", uploadedBy: session.user.id,
    }).onConflictDoNothing({ target: [documents.restaurantId, documents.contentHash] })
      .returning({ id: documents.id });

    if (inserted.length) {
      await tx.insert(documentBlobs).values({ documentId: inserted[0].id, restaurantId: rid, bytes });
      return { id: inserted[0].id, status: "pending" as const, created: true };
    }
    // Duplicate (restaurant_id, content_hash): return the existing doc; retry if it failed.
    const [existing] = await tx.select({ id: documents.id, status: documents.status })
      .from(documents).where(and(eq(documents.restaurantId, rid), eq(documents.contentHash, contentHash))).limit(1);
    if (existing.status === "failed") {
      await tx.update(documents).set({ status: "pending", error: null }).where(eq(documents.id, existing.id));
      return { id: existing.id, status: "pending" as const, created: false };
    }
    return { id: existing.id, status: existing.status, created: false };
  });

  return NextResponse.json({ documentId: result.id, status: result.status }, { status: result.created ? 202 : 200 });
}

// GET /api/documents — owner|manager. Cursor pagination on created_at.
export async function GET(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");
  const rid = session.restaurant.id;

  const cursor = new URL(req.url).searchParams.get("cursor");
  const rows = await withTenant(rid, (tx) =>
    tx.select({
      id: documents.id,
      title: documents.title,
      status: documents.status,
      error: documents.error,
      createdAt: documents.createdAt,
      chunkCount: sql<number>`(select count(*)::int from ${chunks} where ${chunks.documentId} = ${documents.id})`,
    }).from(documents)
      .where(cursor ? lt(documents.createdAt, new Date(cursor)) : undefined)
      .orderBy(desc(documents.createdAt))
      .limit(PAGE_SIZE + 1));

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  return NextResponse.json({
    items: page.map((d) => ({
      id: d.id, title: d.title, status: d.status, error: d.error,
      chunkCount: d.status === "done" ? d.chunkCount : null,
    })),
    nextCursor: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
  });
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- api/documents`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/documents/route.ts test/helpers/auth.ts test/api/documents.test.ts
git commit -m "Phase 2: POST upload (202/200 idempotent) + GET list (FR-005/008)"
```

---

## Task 10: Status route (`GET /api/documents/:id`)

**Files:**
- Create: `src/app/api/documents/[id]/route.ts`
- Test: `test/api/document-status.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/api/document-status.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/documents/route";
import { GET } from "@/app/api/documents/[id]/route";
import { registerOwner, makeUserCookie } from "../helpers/auth";
import { cleanup } from "../helpers/db";
import { makeMinimalPdf } from "../helpers/pdf";

afterEach(cleanup);

function uploadReq(cookie: string, bytes: Buffer) {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(bytes)], "menu.pdf", { type: "application/pdf" }));
  return new Request("http://x/api/documents", { method: "POST", headers: { cookie }, body: fd });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/documents/:id", () => {
  it("returns status for this tenant's document", async () => {
    const owner = await registerOwner();
    const up = await (await POST(uploadReq(owner.cookie, makeMinimalPdf("status test")))).json();
    const res = await GET(new Request("http://x/api/documents/" + up.documentId, { headers: { cookie: owner.cookie } }), ctx(up.documentId));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe(up.documentId);
    expect(json.status).toBe("pending");
    expect(json.chunkCount).toBeNull();
  });

  it("404s a document that belongs to another tenant", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    const up = await (await POST(uploadReq(a.cookie, makeMinimalPdf("a-only")))).json();
    const res = await GET(new Request("http://x/api/documents/" + up.documentId, { headers: { cookie: b.cookie } }), ctx(up.documentId));
    expect(res.status).toBe(404);
  });

  it("404s a non-uuid / unknown id", async () => {
    const owner = await registerOwner();
    const res = await GET(new Request("http://x/api/documents/not-a-uuid", { headers: { cookie: owner.cookie } }), ctx("not-a-uuid"));
    expect(res.status).toBe(404);
  });

  it("403s a trainee", async () => {
    const owner = await registerOwner();
    const trainee = await makeUserCookie(owner.restaurant.id, "trainee");
    const res = await GET(new Request("http://x/api/documents/" + crypto.randomUUID(), { headers: { cookie: trainee.cookie } }), ctx(crypto.randomUUID()));
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- document-status`
Expected: FAIL — `@/app/api/documents/[id]/route` does not exist.

- [ ] **Step 3: Write the route**

`src/app/api/documents/[id]/route.ts`:
```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { documents, chunks } from "@/db/schema";
import { requireSession, hasRole } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";

const Uuid = z.string().uuid();

// GET /api/documents/:id — owner|manager, this tenant's document only.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");

  const { id } = await ctx.params;
  if (!Uuid.safeParse(id).success) return errorResponse("NOT_FOUND", "Document not found"); // not a real id

  const [doc] = await withTenant(session.restaurant.id, (tx) =>
    tx.select({
      id: documents.id,
      title: documents.title,
      status: documents.status,
      error: documents.error,
      chunkCount: sql<number>`(select count(*)::int from ${chunks} where ${chunks.documentId} = ${documents.id})`,
    }).from(documents).where(eq(documents.id, id)).limit(1));

  if (!doc) return errorResponse("NOT_FOUND", "Document not found"); // RLS hides other tenants -> 404
  return NextResponse.json({
    id: doc.id, title: doc.title, status: doc.status, error: doc.error,
    chunkCount: doc.status === "done" ? doc.chunkCount : null,
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- document-status`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/documents/[id]/route.ts" test/api/document-status.test.ts
git commit -m "Phase 2: GET /api/documents/:id status (chunkCount, 404 anti-enumeration) (FR-009)"
```

---

## Task 11: End-to-end test (upload → worker → status → dedup → isolation)

**Files:**
- Test: `test/api/documents.e2e.test.ts`

This is the Phase-2 definition-of-done proof. `embed` is mocked (no OpenAI); everything else is real.

- [ ] **Step 1: Write the end-to-end test**

`test/api/documents.e2e.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { chunks } from "@/db/schema";
import { cleanup } from "../helpers/db";
import { registerOwner } from "../helpers/auth";
import { makeMinimalPdf } from "../helpers/pdf";

vi.mock("@/lib/ai/embeddings", () => ({
  EMBEDDING_MODEL: "text-embedding-3-small",
  EMBEDDING_DIM: 1536,
  embeddingCostUsd: (t: number) => t * (0.02 / 1_000_000),
  embed: vi.fn(async (texts: string[]) => ({
    vectors: texts.map(() => Array(1536).fill(0.03)),
    usageTokens: texts.length * 7,
  })),
}));

import { POST } from "@/app/api/documents/route";
import { GET as getStatus } from "@/app/api/documents/[id]/route";
import { runOnce } from "@/worker/index";

afterEach(cleanup);

function uploadReq(cookie: string, bytes: Buffer) {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(bytes)], "menu.pdf", { type: "application/pdf" }));
  return new Request("http://x/api/documents", { method: "POST", headers: { cookie }, body: fd });
}
const statusReq = (cookie: string, id: string) =>
  getStatus(new Request("http://x/api/documents/" + id, { headers: { cookie } }), { params: Promise.resolve({ id }) });

describe("ingestion end-to-end", () => {
  it("upload -> worker -> done + queryable tenant-scoped chunks; re-upload dedups; other tenant cannot see it", async () => {
    const owner = await registerOwner();
    const bytes = makeMinimalPdf("End to end grounded ingestion proof");

    // Upload (202 pending).
    const up = await (await POST(uploadReq(owner.cookie, bytes))).json();

    // Worker processes exactly one job.
    const processedId = await runOnce();
    expect(processedId).toBe(up.documentId);

    // Status now done with a chunk count.
    const status = await (await statusReq(owner.cookie, up.documentId)).json();
    expect(status.status).toBe("done");
    expect(status.chunkCount).toBeGreaterThan(0);

    // Chunks exist, all scoped to this tenant, 1536-d embeddings.
    const ownerChunks = await withTenant(owner.restaurant.id, (tx) =>
      tx.select().from(chunks).where(eq(chunks.documentId, up.documentId)));
    expect(ownerChunks.length).toBe(status.chunkCount);
    expect(ownerChunks.every((c) => c.restaurantId === owner.restaurant.id)).toBe(true);
    expect(ownerChunks[0].embedding).toHaveLength(1536);

    // Re-upload identical bytes -> 200, no new job, no duplicate chunks.
    const dup = await POST(uploadReq(owner.cookie, bytes));
    expect(dup.status).toBe(200);
    expect(await runOnce()).toBeNull();
    const afterDup = await withTenant(owner.restaurant.id, (tx) =>
      tx.select().from(chunks).where(eq(chunks.documentId, up.documentId)));
    expect(afterDup.length).toBe(ownerChunks.length);

    // Isolation: a second tenant sees neither the document nor its chunks.
    const other = await registerOwner();
    expect((await statusReq(other.cookie, up.documentId)).status).toBe(404);
    const otherView = await withTenant(other.restaurant.id, (tx) =>
      tx.select().from(chunks).where(eq(chunks.documentId, up.documentId)));
    expect(otherView).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it passes** (modules already exist → should pass directly)

Run: `npm test -- documents.e2e`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/api/documents.e2e.test.ts
git commit -m "Phase 2: end-to-end ingestion test (upload->worker->done, dedup, isolation) — DoD proof (FR-005-010)"
```

---

## Task 12: Full verification + docs/status update

**Files:**
- Modify: `CLAUDE.md` (Current status block)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: ALL pass (Phase 1 suite + the new Phase 2 tests). If any Phase 1 test regressed, fix before continuing.

- [ ] **Step 2: Typecheck + production build**

Run: `npx tsc --noEmit && npm run build`
Expected: `tsc` clean; `next build` green. (The pre-existing "additional lockfiles" Turbopack warning is unrelated and OK.)

- [ ] **Step 3: Update `CLAUDE.md` "Current status"**

Replace the `**Next step → Phase 2 ...**` block with a Phase 2 completion summary in the same style as the Phase 1 block, and set the next step to Phase 3. Suggested text:
```markdown
**Phase 2 — COMPLETE.** Document ingestion (FR-005–009), tested + built. Spec/plan:
`docs/superpowers/{specs,plans}/2026-05-31-phase-2-document-ingestion*`.
- **Upload:** `POST /api/documents` (owner|manager, multipart) → raw bytes to `document_blobs`
  (bytea, migration 0003, RLS), `202 {documentId, pending}`; byte-identical re-upload is
  idempotent (`200`, failed→pending retry). `content_hash` = SHA-256 of raw bytes (pre-parse).
- **Worker:** polling loop (`npm run worker`, tsx + `tsconfig.worker.json` aliasing `server-only`).
  Two-phase: a PRIVILEGED `WORKER_DATABASE_URL` (dev: reg superuser) claims one job
  (`UPDATE … FOR UPDATE SKIP LOCKED`, status flip = lock) + reclaims stale `processing`; the work
  (read blob → parse `unpdf` → deterministic chunk `gpt-tokenizer`/cl100k → embed
  `text-embedding-3-small` 1536d → write `chunks` + `usage_events`, drop blob, mark done|failed)
  runs as `reg_app` under `withTenant`. Blob kept on failure for retry.
- **Status:** `GET /api/documents` (cursor) + `GET /api/documents/:id` (chunkCount when done; 404s
  other tenants). Determinism, dedup, failure path, and cross-tenant isolation all covered by tests.

Known gaps carried forward: least-priv `reg_worker` role (dev reuses `reg` via `WORKER_DATABASE_URL`)
+ Docker Compose worker service → Phase 8; DOCX/text parsers → Stretch; per-tenant upload limits
(FR-026) → Phase 7; Vercel AI SDK arrives in Phase 3 (generation).

**Next step → Phase 3 (Retrieval + grounded Q&A, FR-010–014).**
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "Phase 2 complete: update build status; next is Phase 3 (retrieval + grounded Q&A)"
```

---

## Self-review notes (author check against the spec)

- **Spec coverage:** FR-005 (Task 9), FR-006 (Task 3), FR-007 (Tasks 5, 7), FR-008 (Tasks 9, 11), FR-009 (Tasks 6, 8, 10), FR-023 seed (Task 7 usage_events), FR-025 seed (Task 7 structured logs). Schema delta + RLS (Task 2). Two-role claim/work split (Tasks 6, 7). All five spec "decisions locked" are realized: bytea blob (T2), two-phase worker (T6/T7), raw-bytes hash + idempotent re-upload (T9), gpt-tokenizer (T3).
- **Type consistency:** `ClaimedJob` (claim.ts) is consumed unchanged by `processDocument` (T7) and `runOnce` (T8). `Chunk {text, tokenCount, chunkIndex}` (T3) maps to `chunks` insert (T7). `embed → {vectors, usageTokens}` (T5) used in T7 and mocked identically in T7/T8/T11.
- **No placeholders:** every step has concrete code/commands/expected output. The chunker reference (T3) is complete and is explicitly David's to (re)write against the provided tests.
