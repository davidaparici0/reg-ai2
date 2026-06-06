# Phase 3 — Retrieval + Grounded Q&A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `POST /api/ask` — a trainee asks a question and gets a grounded, cited answer from their restaurant's own chunks, or an honest fallback — verified against the 15-question eval set with zero cross-tenant leaks.

**Architecture:** One request path inside a single `withTenant` transaction: embed question → tenant-scoped top-k vector search → threshold gate → generate-from-context OR no-LLM fallback → persist message + grounding sources. Menu data is rendered to text cards and embedded into the same `chunks` table, so there is exactly one retrieval path. A seed script stands up a real demo corpus and an eval harness calibrates the threshold.

**Tech Stack:** Next.js 16 Route Handler, Drizzle + `pg`, pgvector 0.8.2 (HNSW/cosine), OpenAI (`text-embedding-3-small` + `gpt-4.1-mini`), Zod 4, vitest + real Postgres, `tsx` for scripts, `yaml` for the eval set.

**Spec:** `docs/superpowers/specs/2026-06-06-phase-3-retrieval-grounded-qa-design.md`. Canonical contracts: `docs/rag.md`, `docs/api.md §2.3`, `schema.ts`.

---

## File map

| File | Create/Modify | Responsibility |
|---|---|---|
| `schema.ts` | Modify | Add `restaurantId` to `messages` + `messageSources` (+ indexes) |
| `drizzle/0004_*.sql` | Create (generate + hand-edit) | Columns + RLS on `conversations`/`messages`/`message_sources` |
| `src/lib/ai/generate.ts` | Create | Completion seam: `gpt-4.1-mini`, `temperature:0`, cost |
| `src/lib/qa/retrieve.ts` | Create | Tenant-scoped vector search + D2 recall settings |
| `src/lib/qa/menu-card.ts` | Create | `menu_item` → deterministic text card |
| `src/lib/qa/prompt.ts` | Create | `buildPrompt` + `FALLBACK_TEXT` (**David finalizes wording**) |
| `src/lib/qa/answer.ts` | Create | Orchestrator + `THRESHOLD` (**David owns logic + number**) |
| `src/app/api/ask/route.ts` | Create | `POST /api/ask` handler |
| `eval/content.ts` | Create | Authored demo-corpus fixtures (docs + menu, A and B) |
| `eval/seed.ts` | Create | Idempotent seeder (runs the real chunk+embed path) |
| `eval/run.ts` | Create | Calibration + verification harness |
| `package.json` | Modify | `eval:seed` / `eval:run` scripts; add `yaml` |
| test files | Create | One per module (see tasks) |

**Shared types (defined once, referenced everywhere):**
- `ChatMessage` (in `generate.ts`): `{ role: "system" | "user" | "assistant"; content: string }`
- `RetrievedChunk` (in `retrieve.ts`): `{ chunkId, documentId, documentTitle, text, similarity }`
- `Source` / `AnswerResult` (in `answer.ts`): the `AskResponse` body per `api.md §2.3`.

**Reused as-is:** `withTenant`, `Tx` (`@/lib/db`); `embed`, `embeddingCostUsd`, `EMBEDDING_MODEL` (`@/lib/ai/embeddings`); `requireSession` (`@/lib/auth/guard`); `errorResponse` (`@/lib/http/errors`); `track`/`cleanup`, `registerOwner`/`makeUserCookie` (test helpers).

---

## Task 1: Migration 0004 — RLS on the Q&A tables

Completes the RLS deferred for `conversations`/`messages`/`message_sources`. Denormalizes `restaurant_id` onto `messages` + `message_sources` so the same `tenant_isolation` policy applies (mirrors `chunks`/`document_blobs`).

**Files:**
- Modify: `schema.ts` (`messages`, `messageSources`)
- Create: `drizzle/0004_<name>.sql` (generate, then hand-add RLS)
- Test: `test/lib/db.qaRls.test.ts`

- [ ] **Step 1: Add `restaurantId` + index to `messages` and `messageSources` in `schema.ts`**

In the `messages` table object, add the column after `conversationId`:
```ts
    restaurantId: uuid("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
```
and add to its index array:
```ts
    index("messages_restaurant_idx").on(t.restaurantId),
```
In the `messageSources` table object, add the column after `chunkId`:
```ts
    restaurantId: uuid("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
```
and add to its index array:
```ts
    index("message_sources_restaurant_idx").on(t.restaurantId),
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/0004_<name>.sql` adding the two columns + FKs + indexes. (Drizzle will NOT emit RLS — we add it next.)

- [ ] **Step 3: Hand-add RLS to the generated `drizzle/0004_<name>.sql`**

Append these statements (match the `0003` style exactly — `statement-breakpoint` between each):
```sql
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversations"
  USING      ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "messages"
  USING      ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "message_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_sources" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "message_sources"
  USING      ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);
```

- [ ] **Step 4: Apply the migration**

Run: `npm run db:migrate`
Expected: migration 0004 applies clean (Docker Postgres must be up: `docker compose up -d`).

- [ ] **Step 5: Write the failing RLS test**

Create `test/lib/db.qaRls.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { restaurants, users, conversations, messages } from "@/db/schema";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

async function seedConversationWithMessage(name: string) {
  const [r] = await db.insert(restaurants).values({ name }).returning();
  track(r.id);
  const [u] = await db.insert(users).values({
    restaurantId: r.id, email: `${crypto.randomUUID()}@t.test`, passwordHash: "x", role: "owner",
  }).returning();
  return withTenant(r.id, async (tx) => {
    const [c] = await tx.insert(conversations).values({ restaurantId: r.id, userId: u.id }).returning();
    const [m] = await tx.insert(messages).values({
      conversationId: c.id, restaurantId: r.id, role: "user", content: `${name}-msg`,
    }).returning();
    return { restaurant: r, user: u, conversation: c, message: m };
  });
}

describe("Q&A tables + RLS", () => {
  it("scopes message reads to the GUC tenant", async () => {
    const a = await seedConversationWithMessage("QAA");
    const b = await seedConversationWithMessage("QAB");

    const aMsgs = await withTenant(a.restaurant.id, (tx) => tx.select().from(messages));
    expect(aMsgs.map((m) => m.id)).toEqual([a.message.id]);

    const leak = await withTenant(a.restaurant.id, (tx) =>
      tx.select().from(messages).where(eq(messages.id, b.message.id)));
    expect(leak).toHaveLength(0);
  });

  it("WITH CHECK blocks writing a message for a different tenant", async () => {
    const a = await seedConversationWithMessage("QAC");
    const b = await seedConversationWithMessage("QAD");
    // Under A's GUC, inserting a message tagged for B fails the policy's WITH CHECK.
    await expect(
      withTenant(a.restaurant.id, (tx) =>
        tx.insert(messages).values({
          conversationId: b.conversation.id, restaurantId: b.restaurant.id, role: "user", content: "evil",
        })),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Run it to verify it passes**

Run: `npx vitest run test/lib/db.qaRls.test.ts`
Expected: PASS (2 tests). If the leak test returns a row, RLS wasn't applied — recheck Step 3/4.

- [ ] **Step 7: Commit**
```bash
git add schema.ts drizzle/0004_*.sql drizzle/meta test/lib/db.qaRls.test.ts
git commit -m "Phase 3: migration 0004 — RLS + restaurant_id on conversations/messages/message_sources"
```

---

## Task 2: Generation seam (`ai/generate.ts`)

Mirrors `embeddings.ts`: one swappable boundary, server-only, deterministic.

**Files:**
- Create: `src/lib/ai/generate.ts`
- Test: `test/lib/generate.test.ts`

- [ ] **Step 1: Write the failing test** (OpenAI mocked — no network, no key)

Create `test/lib/generate.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
// vitest 4.x: a factory used as a CONSTRUCTOR must be a regular function, not an arrow.
vi.mock("openai", () => ({ default: vi.fn(function () { return { chat: { completions: { create } } }; }) }));

beforeEach(() => {
  vi.resetModules();
  create.mockReset();
  process.env.OPENAI_API_KEY = "test-key";
});

describe("generate()", () => {
  it("returns trimmed text + token usage and calls the locked model at temperature 0", async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: "  The answer [1].  " } }],
      usage: { prompt_tokens: 120, completion_tokens: 18 },
    });
    const { generate } = await import("@/lib/ai/generate");
    const out = await generate([{ role: "user", content: "hi" }]);
    expect(out.text).toBe("The answer [1].");
    expect(out.inputTokens).toBe(120);
    expect(out.outputTokens).toBe(18);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4.1-mini", temperature: 0 }),
    );
  });

  it("computes completion cost from the locked per-token prices", async () => {
    const { completionCostUsd } = await import("@/lib/ai/generate");
    // 1M input + 1M output at $0.40 + $1.60
    expect(completionCostUsd(1_000_000, 1_000_000)).toBeCloseTo(2.0, 6);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib/generate.test.ts`
Expected: FAIL — `Cannot find module '@/lib/ai/generate'`.

- [ ] **Step 3: Write the module**

Create `src/lib/ai/generate.ts`:
```ts
// The single, swappable text-generation boundary. server-only: the OpenAI key never reaches
// client code and is never logged. Model is a one-line swap (rag.md §8 / Phase 3 spec §5.2).
import "server-only";
import OpenAI from "openai";

export const COMPLETION_MODEL = "gpt-4.1-mini";
// CONFIRM against current OpenAI pricing at build time (Phase 3 spec §11):
const COST_INPUT_PER_TOKEN = 0.40 / 1_000_000;  // ~$0.40 / 1M input tokens
const COST_OUTPUT_PER_TOKEN = 1.60 / 1_000_000; // ~$1.60 / 1M output tokens

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set (server-only).");
  client = new OpenAI({ apiKey });
  return client;
}

export function completionCostUsd(inTok: number, outTok: number): number {
  return inTok * COST_INPUT_PER_TOKEN + outTok * COST_OUTPUT_PER_TOKEN;
}

export async function generate(messages: ChatMessage[]): Promise<{
  text: string; inputTokens: number; outputTokens: number;
}> {
  // temperature 0: grounded Q&A wants determinism (and reproducible evals), not creativity.
  const res = await getClient().chat.completions.create({
    model: COMPLETION_MODEL, temperature: 0, messages,
  });
  const text = (res.choices[0]?.message?.content ?? "").trim();
  return {
    text,
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/lib/generate.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**
```bash
git add src/lib/ai/generate.ts test/lib/generate.test.ts
git commit -m "Phase 3: generation seam (gpt-4.1-mini, temp 0) + cost (FR-011/FR-023)"
```

---

## Task 3: Tenant-scoped retrieval (`qa/retrieve.ts`) — **David owns the query**

**Files:**
- Create: `src/lib/qa/retrieve.ts`
- Test: `test/lib/retrieve.test.ts`

- [ ] **Step 1: Write the failing test** (real Postgres; crafted 1536-d embeddings)

Create `test/lib/retrieve.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { db, withTenant } from "@/lib/db";
import { restaurants, documents, chunks } from "@/db/schema";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

// A 1536-d basis vector with a single 1 at position i (cosine-friendly fixtures).
const basis = (i: number) => { const v = Array(1536).fill(0); v[i] = 1; return v; };

async function seedChunk(restaurantId: string, docId: string, idx: number, text: string, emb: number[]) {
  await withTenant(restaurantId, (tx) =>
    tx.insert(chunks).values({
      documentId: docId, restaurantId, chunkIndex: idx, text, tokenCount: 5, embedding: emb,
    }));
}

async function seedRestaurant(name: string) {
  const [r] = await db.insert(restaurants).values({ name }).returning();
  track(r.id);
  const [doc] = await withTenant(r.id, (tx) =>
    tx.insert(documents).values({
      restaurantId: r.id, title: `${name} doc`, sourceType: "text", contentHash: `${name}-${crypto.randomUUID()}`, status: "done",
    }).returning());
  return { id: r.id, docId: doc.id };
}

describe("retrieve()", () => {
  it("returns this tenant's chunks ordered by cosine similarity", async () => {
    const a = await seedRestaurant("RETA");
    await seedChunk(a.id, a.docId, 0, "alpha chunk", basis(0));
    await seedChunk(a.id, a.docId, 1, "beta chunk", basis(1));
    const { retrieve } = await import("@/lib/qa/retrieve");

    const res = await withTenant(a.id, (tx) => retrieve(tx, basis(0), 5));
    expect(res[0].text).toBe("alpha chunk");
    expect(res[0].similarity).toBeCloseTo(1, 5);
    expect(res[0].documentTitle).toBe("RETA doc");
    expect(res[1].similarity).toBeCloseTo(0, 5);
  });

  it("never returns another tenant's chunks", async () => {
    const a = await seedRestaurant("RETB");
    const b = await seedRestaurant("RETC");
    await seedChunk(b.id, b.docId, 0, "secret B chunk", basis(0));
    const { retrieve } = await import("@/lib/qa/retrieve");

    const res = await withTenant(a.id, (tx) => retrieve(tx, basis(0), 5));
    expect(res).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib/retrieve.test.ts`
Expected: FAIL — `Cannot find module '@/lib/qa/retrieve'`.

- [ ] **Step 3: Write the retrieval module** (David: write the query yourself, then compare)

Create `src/lib/qa/retrieve.ts`:
```ts
// Tenant-scoped vector search — the hot path of the crown jewel (FR-010).
// restaurant_id is the first predicate (isolation in the query); RLS is the backstop.
import "server-only";
import { sql } from "drizzle-orm";
import type { Tx } from "@/lib/db";

export type RetrievedChunk = {
  chunkId: string; documentId: string; documentTitle: string; text: string; similarity: number;
};

export async function retrieve(tx: Tx, queryEmbedding: number[], k = 5): Promise<RetrievedChunk[]> {
  // pgvector text repr: "[0.1,0.2,...]" cast to ::vector.
  const vec = `[${queryEmbedding.join(",")}]`;

  // D2 filtered-HNSW recall ladder (transaction-local — no leak):
  //  rung 1: widen the HNSW candidate list; rung 2: iterative scan (pgvector 0.8+) so the
  //  post-filter on restaurant_id still yields up to k rows for a sparse tenant.
  await tx.execute(sql`set local hnsw.ef_search = 100`);
  await tx.execute(sql`set local hnsw.iterative_scan = 'relaxed_order'`);

  const res = await tx.execute(sql`
    select c.id as chunk_id, c.document_id, d.title as document_title, c.text,
           1 - (c.embedding <=> ${vec}::vector) as similarity
    from chunks c
    join documents d on d.id = c.document_id
    where c.restaurant_id = current_setting('app.restaurant_id', true)::uuid
    order by c.embedding <=> ${vec}::vector
    limit ${k}
  `);

  return res.rows.map((r) => ({
    chunkId: r.chunk_id as string,
    documentId: r.document_id as string,
    documentTitle: r.document_title as string,
    text: r.text as string,
    similarity: Number(r.similarity),
  }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/lib/retrieve.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**
```bash
git add src/lib/qa/retrieve.ts test/lib/retrieve.test.ts
git commit -m "Phase 3: tenant-scoped vector retrieval + D2 recall settings (FR-010)"
```

---

## Task 4: Menu card renderer (`qa/menu-card.ts`)

Deterministic `menu_item` → text card, faithful to the controlled allergen vocabulary (never asserts an unlisted allergen is absent).

**Files:**
- Create: `src/lib/qa/menu-card.ts`
- Test: `test/lib/menu-card.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/lib/menu-card.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { menuCard, type MenuCardInput } from "@/lib/qa/menu-card";

const scallops: MenuCardInput = {
  name: "Seared Scallops",
  description: "Pan-seared, citrus beurre blanc",
  ingredients: ["scallops", "butter", "citrus"],
  allergens: ["shellfish"],   // note: NO milk recorded
  dietaryFlags: null,
  price: "38.00",
};

describe("menuCard()", () => {
  it("is deterministic", () => {
    expect(menuCard(scallops)).toBe(menuCard(scallops));
  });

  it("lists only recorded allergens and flags the unknown rest to the kitchen", () => {
    const card = menuCard(scallops);
    expect(card).toContain("Seared Scallops");
    expect(card).toContain("Allergens (recorded): shellfish");
    expect(card).toContain("confirm with the kitchen");
    // must NOT assert anything about dairy either way
    expect(card.toLowerCase()).not.toContain("dairy-free");
    expect(card.toLowerCase()).not.toContain("milk");
  });

  it("renders empty allergen/dietary as 'none recorded'", () => {
    const card = menuCard({ ...scallops, allergens: [], dietaryFlags: [] });
    expect(card).toContain("Allergens (recorded): none recorded");
    expect(card).toContain("Dietary: none recorded");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib/menu-card.test.ts`
Expected: FAIL — `Cannot find module '@/lib/qa/menu-card'`.

- [ ] **Step 3: Write the module**

Create `src/lib/qa/menu-card.ts`:
```ts
// Deterministic text rendering of a menu item, embedded into `chunks` so menu questions
// flow through the SAME retrieval path as documents (Phase 3 spec §2). Safety: render only
// the RECORDED allergens; the closing note pushes unknowns to the kitchen (FR-014). Never
// claim an unlisted allergen is absent. Reused by Phase 4 menu CRUD.
export type MenuCardInput = {
  name: string;
  description: string | null;
  ingredients: string[] | null;
  allergens: string[] | null;
  dietaryFlags: string[] | null;
  price: string | null; // drizzle numeric -> string
};

const list = (xs: string[] | null, empty: string) => (xs && xs.length ? xs.join(", ") : empty);

export function menuCard(item: MenuCardInput): string {
  return [
    `Dish: ${item.name}.`,
    item.description ? `Description: ${item.description}.` : null,
    `Ingredients: ${list(item.ingredients, "not listed")}.`,
    `Allergens (recorded): ${list(item.allergens, "none recorded")}.`,
    `Dietary: ${list(item.dietaryFlags, "none recorded")}.`,
    item.price ? `Price: $${item.price}.` : null,
    `Note: allergens not listed above are not recorded in our data — confirm with the kitchen.`,
  ].filter(Boolean).join(" ");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/lib/menu-card.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**
```bash
git add src/lib/qa/menu-card.ts test/lib/menu-card.test.ts
git commit -m "Phase 3: deterministic menu-item -> text card renderer (FR-014)"
```

---

## Task 5: Prompt template (`qa/prompt.ts`) — **David finalizes the wording**

**Files:**
- Create: `src/lib/qa/prompt.ts`
- Test: `test/lib/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/lib/prompt.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildPrompt, FALLBACK_TEXT } from "@/lib/qa/prompt";
import type { RetrievedChunk } from "@/lib/qa/retrieve";

const chunk = (id: string, text: string): RetrievedChunk =>
  ({ chunkId: id, documentId: "d", documentTitle: "Doc", text, similarity: 0.9 });

describe("buildPrompt()", () => {
  it("returns a system+user pair with numbered context and the restaurant name", () => {
    const msgs = buildPrompt("Le Test", [chunk("1", "AAA"), chunk("2", "BBB")], "what is X?");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("Le Test");
    expect(msgs[0].content).toContain("[1] AAA");
    expect(msgs[0].content).toContain("[2] BBB");
    expect(msgs[0].content).toContain(FALLBACK_TEXT);
    expect(msgs[1]).toEqual({ role: "user", content: "what is X?" });
  });

  it("exports a non-empty fallback string", () => {
    expect(FALLBACK_TEXT.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib/prompt.test.ts`
Expected: FAIL — `Cannot find module '@/lib/qa/prompt'`.

- [ ] **Step 3: Write the module** (first draft — David rewrites the wording in Task 10)

Create `src/lib/qa/prompt.ts`:
```ts
// The grounding prompt (rag.md §5). The RULES are requirements; the WORDING is David's to
// finalize (// DAVID below). FALLBACK_TEXT is shared with answer.ts so "below threshold" and
// "model declined" produce identical user-facing text.
import type { ChatMessage } from "@/lib/ai/generate";
import type { RetrievedChunk } from "@/lib/qa/retrieve";

// DAVID: finalize this exact refusal string.
export const FALLBACK_TEXT =
  "I don't have that in this restaurant's materials — please check with your manager.";

export function buildPrompt(restaurantName: string, chunks: RetrievedChunk[], question: string): ChatMessage[] {
  const context = chunks.map((c, i) => `[${i + 1}] ${c.text}`).join("\n\n");
  // DAVID: finalize this wording. Keep the four rules (answer only from context; exact
  // FALLBACK_TEXT on a miss; allergen/food-safety caution; concise).
  const system =
    `You are a training assistant for ${restaurantName}. Answer ONLY using the numbered ` +
    `context below, which comes from this restaurant's own materials.\n\n` +
    `Rules:\n` +
    `- If the context does not contain the answer, reply EXACTLY: "${FALLBACK_TEXT}" ` +
    `Do not use outside knowledge. Do not guess.\n` +
    `- Cite the context you used by its [number].\n` +
    `- For allergen, dietary, or food-safety questions: state only what the context explicitly ` +
    `says. If it is incomplete or absent, say so and advise confirming with the kitchen or ` +
    `manager. Never call something "safe" beyond what the context supports.\n` +
    `- Be concise and practical — staff may be reading this mid-shift.\n\n` +
    `CONTEXT:\n${context}`;
  return [
    { role: "system", content: system },
    { role: "user", content: question },
  ];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/lib/prompt.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**
```bash
git add src/lib/qa/prompt.ts test/lib/prompt.test.ts
git commit -m "Phase 3: grounding prompt template + shared FALLBACK_TEXT (FR-011/FR-012/FR-014)"
```

---

## Task 6: Answer orchestrator (`qa/answer.ts`) — **David owns the grounding logic + THRESHOLD**

**Files:**
- Create: `src/lib/qa/answer.ts`
- Test: `test/lib/answer.test.ts`

- [ ] **Step 1: Write the failing tests** (embed + generate mocked; retrieval + persistence real)

Create `test/lib/answer.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module mocks use ARROW factories (only constructor mocks need a regular function).
const embedMock = vi.fn();
const generateMock = vi.fn();
vi.mock("@/lib/ai/embeddings", () => ({
  embed: embedMock,
  embeddingCostUsd: (t: number) => t * 1e-8,
  EMBEDDING_MODEL: "text-embedding-3-small",
  EMBEDDING_DIM: 1536,
}));
vi.mock("@/lib/ai/generate", () => ({
  generate: generateMock,
  completionCostUsd: () => 0,
  COMPLETION_MODEL: "gpt-4.1-mini",
}));

import { db, withTenant } from "@/lib/db";
import { restaurants, users, documents, chunks, messages, messageSources, usageEvents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);
beforeEach(() => { embedMock.mockReset(); generateMock.mockReset(); });

const basis = (i: number) => { const v = Array(1536).fill(0); v[i] = 1; return v; };

async function seedTenant(name: string, withChunk: boolean) {
  const [r] = await db.insert(restaurants).values({ name }).returning();
  track(r.id);
  const [u] = await db.insert(users).values({
    restaurantId: r.id, email: `${crypto.randomUUID()}@t.test`, passwordHash: "x", role: "owner",
  }).returning();
  if (withChunk) {
    const [doc] = await withTenant(r.id, (tx) =>
      tx.insert(documents).values({
        restaurantId: r.id, title: "Doc", sourceType: "text", contentHash: `${name}-${crypto.randomUUID()}`, status: "done",
      }).returning());
    await withTenant(r.id, (tx) =>
      tx.insert(chunks).values({
        documentId: doc.id, restaurantId: r.id, chunkIndex: 0, text: "the relevant fact", tokenCount: 5, embedding: basis(0),
      }));
  }
  return { id: r.id, userId: u.id, name };
}

describe("answer()", () => {
  it("grounded path: generates, persists sources + 2 usage rows", async () => {
    const t = await seedTenant("ANSA", true);
    embedMock.mockResolvedValue({ vectors: [basis(0)], usageTokens: 7 });
    generateMock.mockResolvedValue({ text: "The fact is X [1].", inputTokens: 50, outputTokens: 6 });
    const { answer } = await import("@/lib/qa/answer");

    const res = await withTenant(t.id, (tx) => answer(tx, {
      restaurantId: t.id, userId: t.userId, restaurantName: t.name, question: "what is the fact?",
    }));

    expect(res.grounded).toBe(true);
    expect(res.answer).toBe("The fact is X [1].");
    expect(res.sources).toHaveLength(1);
    expect(res.sources[0].snippet).toBe("the relevant fact");
    expect(generateMock).toHaveBeenCalledOnce();

    const srcRows = await withTenant(t.id, (tx) =>
      tx.select().from(messageSources).where(eq(messageSources.messageId, res.messageId)));
    expect(srcRows).toHaveLength(1);
    const usage = await withTenant(t.id, (tx) => tx.select().from(usageEvents));
    expect(usage.map((u) => u.kind).sort()).toEqual(["completion", "embedding"]);
  });

  it("weak retrieval: falls back WITHOUT calling the model, no completion usage", async () => {
    const t = await seedTenant("ANSB", false); // no chunks -> empty retrieval
    embedMock.mockResolvedValue({ vectors: [basis(0)], usageTokens: 7 });
    const { answer } = await import("@/lib/qa/answer");
    const { FALLBACK_TEXT } = await import("@/lib/qa/prompt");

    const res = await withTenant(t.id, (tx) => answer(tx, {
      restaurantId: t.id, userId: t.userId, restaurantName: t.name, question: "anything?",
    }));

    expect(res.grounded).toBe(false);
    expect(res.answer).toBe(FALLBACK_TEXT);
    expect(res.sources).toEqual([]);
    expect(generateMock).not.toHaveBeenCalled();
    const usage = await withTenant(t.id, (tx) => tx.select().from(usageEvents));
    expect(usage.map((u) => u.kind)).toEqual(["embedding"]);
  });

  it("model declines from context (above threshold) -> grounded:false, no sources, completion still billed", async () => {
    const t = await seedTenant("ANSC", true);
    const { FALLBACK_TEXT } = await import("@/lib/qa/prompt");
    embedMock.mockResolvedValue({ vectors: [basis(0)], usageTokens: 7 });
    generateMock.mockResolvedValue({ text: FALLBACK_TEXT, inputTokens: 50, outputTokens: 6 });
    const { answer } = await import("@/lib/qa/answer");

    const res = await withTenant(t.id, (tx) => answer(tx, {
      restaurantId: t.id, userId: t.userId, restaurantName: t.name, question: "what is the fact?",
    }));

    expect(res.grounded).toBe(false);
    expect(res.sources).toEqual([]);
    expect(generateMock).toHaveBeenCalledOnce();
    const usage = await withTenant(t.id, (tx) => tx.select().from(usageEvents));
    expect(usage.map((u) => u.kind).sort()).toEqual(["completion", "embedding"]);
  });
});
```
> Note: drop the `FALLBACK_FROM_PROMPT` reference if you don't add such an export — it's only there to show the import is intentional. The canonical fallback comes from `@/lib/qa/prompt`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib/answer.test.ts`
Expected: FAIL — `Cannot find module '@/lib/qa/answer'`.

- [ ] **Step 3: Write the orchestrator** (David: this is yours — write the gate + flow, then compare)

Create `src/lib/qa/answer.ts`:
```ts
// The crown jewel's grounding logic (FR-010–014). Runs inside a tenant transaction so
// retrieval, generation-gating, and persistence are atomic and RLS-enforced.
import "server-only";
import { and, eq } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { conversations, messages, messageSources, usageEvents } from "@/db/schema";
import { embed, embeddingCostUsd, EMBEDDING_MODEL } from "@/lib/ai/embeddings";
import { generate, completionCostUsd, COMPLETION_MODEL } from "@/lib/ai/generate";
import { retrieve } from "@/lib/qa/retrieve";
import { buildPrompt, FALLBACK_TEXT } from "@/lib/qa/prompt";

// DAVID owns this number. Placeholder — calibrate from eval/run.ts (rag.md §4).
export const THRESHOLD = 0.35;
const K = 5;

export type Source = {
  chunkId: string; documentId: string; documentTitle: string; snippet: string; similarity: number;
};
export type AnswerResult = {
  answer: string; grounded: boolean; sources: Source[]; conversationId: string; messageId: string;
};
export type AnswerInput = {
  restaurantId: string; userId: string; restaurantName: string; question: string; conversationId?: string;
};

export async function answer(tx: Tx, input: AnswerInput): Promise<AnswerResult> {
  const { restaurantId, userId, restaurantName, question } = input;

  // 1. Embed the question (usage tracked below).
  const { vectors, usageTokens: embedTokens } = await embed([question]);
  const qEmb = vectors[0];

  // 2. Tenant-scoped top-k.
  const hits = await retrieve(tx, qEmb, K);

  // 3. The gate: top-1 must clear the threshold, else we decline WITHOUT calling the model.
  const passedGate = hits.length > 0 && hits[0].similarity >= THRESHOLD;

  // 4. Generate from context, or fall back.
  let answerText: string;
  let completion: { inputTokens: number; outputTokens: number } | null = null;
  if (passedGate) {
    const out = await generate(buildPrompt(restaurantName, hits, question));
    answerText = out.text;
    completion = { inputTokens: out.inputTokens, outputTokens: out.outputTokens };
  } else {
    answerText = FALLBACK_TEXT;
  }
  // The model can still decline from context even above threshold -> ungrounded.
  const grounded = passedGate && answerText !== FALLBACK_TEXT;

  // 5. Persist — conversation, both messages, sources (grounded only), usage. Same tx => atomic.
  const conversationId = await resolveConversation(tx, input);
  await tx.insert(messages).values({ conversationId, restaurantId, role: "user", content: question });
  const [assistant] = await tx.insert(messages)
    .values({ conversationId, restaurantId, role: "assistant", content: answerText })
    .returning({ id: messages.id });

  const sources: Source[] = grounded
    ? hits.map((h) => ({
        chunkId: h.chunkId, documentId: h.documentId, documentTitle: h.documentTitle,
        snippet: h.text, similarity: h.similarity,
      }))
    : [];
  if (sources.length) {
    await tx.insert(messageSources).values(sources.map((s) => ({
      messageId: assistant.id, restaurantId, chunkId: s.chunkId, similarity: s.similarity,
    })));
  }

  await tx.insert(usageEvents).values({
    restaurantId, userId, kind: "embedding", model: EMBEDDING_MODEL,
    inputTokens: embedTokens, outputTokens: 0, costUsd: embeddingCostUsd(embedTokens).toFixed(6),
  });
  if (completion) {
    await tx.insert(usageEvents).values({
      restaurantId, userId, kind: "completion", model: COMPLETION_MODEL,
      inputTokens: completion.inputTokens, outputTokens: completion.outputTokens,
      costUsd: completionCostUsd(completion.inputTokens, completion.outputTokens).toFixed(6),
    });
  }

  return { answer: answerText, grounded, sources, conversationId, messageId: assistant.id };
}

// Reuse an owned conversation; a foreign/missing id silently starts a fresh one (no oracle).
async function resolveConversation(tx: Tx, input: AnswerInput): Promise<string> {
  if (input.conversationId) {
    const [existing] = await tx.select({ id: conversations.id }).from(conversations)
      .where(and(eq(conversations.id, input.conversationId), eq(conversations.userId, input.userId)))
      .limit(1);
    if (existing) return existing.id;
  }
  const [created] = await tx.insert(conversations)
    .values({ restaurantId: input.restaurantId, userId: input.userId })
    .returning({ id: conversations.id });
  return created.id;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/lib/answer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**
```bash
git add src/lib/qa/answer.ts test/lib/answer.test.ts
git commit -m "Phase 3: answer orchestrator — gate, generate/fallback, persist (FR-010–014)"
```

---

## Task 7: The route (`POST /api/ask`)

**Files:**
- Create: `src/app/api/ask/route.ts`
- Test: `test/api/ask.test.ts`

- [ ] **Step 1: Write the failing tests** (embed + generate mocked; auth + shape + persistence real)

Create `test/api/ask.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const embedMock = vi.fn();
const generateMock = vi.fn();
vi.mock("@/lib/ai/embeddings", () => ({
  embed: embedMock, embeddingCostUsd: (t: number) => t * 1e-8,
  EMBEDDING_MODEL: "text-embedding-3-small", EMBEDDING_DIM: 1536,
}));
vi.mock("@/lib/ai/generate", () => ({
  generate: generateMock, completionCostUsd: () => 0, COMPLETION_MODEL: "gpt-4.1-mini",
}));

import { POST } from "@/app/api/ask/route";
import { db, withTenant } from "@/lib/db";
import { documents, chunks, messages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { registerOwner } from "../helpers/auth";
import { cleanup } from "../helpers/db";

afterEach(cleanup);
beforeEach(() => { embedMock.mockReset(); generateMock.mockReset(); });

const basis = (i: number) => { const v = Array(1536).fill(0); v[i] = 1; return v; };
const ask = (cookie: string | null, body: unknown) =>
  POST(new Request("http://x/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }));

describe("POST /api/ask", () => {
  it("401 without a session", async () => {
    const res = await ask(null, { question: "hi" });
    expect(res.status).toBe(401);
  });

  it("400 on an invalid body", async () => {
    const { cookie } = await registerOwner();
    const res = await ask(cookie, { question: "" });
    expect(res.status).toBe(400);
  });

  it("returns a grounded AskResponse and persists the turn", async () => {
    const { cookie, restaurant } = await registerOwner();
    const [doc] = await withTenant(restaurant.id, (tx) =>
      tx.insert(documents).values({
        restaurantId: restaurant.id, title: "Doc", sourceType: "text", contentHash: crypto.randomUUID(), status: "done",
      }).returning());
    await withTenant(restaurant.id, (tx) =>
      tx.insert(chunks).values({
        documentId: doc.id, restaurantId: restaurant.id, chunkIndex: 0, text: "the fact", tokenCount: 3, embedding: basis(0),
      }));
    embedMock.mockResolvedValue({ vectors: [basis(0)], usageTokens: 5 });
    generateMock.mockResolvedValue({ text: "Answer [1].", inputTokens: 40, outputTokens: 4 });

    const res = await ask(cookie, { question: "what is the fact?" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.grounded).toBe(true);
    expect(body.sources).toHaveLength(1);
    expect(typeof body.conversationId).toBe("string");
    expect(typeof body.messageId).toBe("string");

    const msgs = await withTenant(restaurant.id, (tx) =>
      tx.select().from(messages).where(eq(messages.conversationId, body.conversationId)));
    expect(msgs.map((m) => m.role).sort()).toEqual(["assistant", "user"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/api/ask.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/ask/route'`.

- [ ] **Step 3: Write the route**

Create `src/app/api/ask/route.ts`:
```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenant } from "@/lib/db";
import { requireSession } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { answer } from "@/lib/qa/answer";

// POST /api/ask — any authenticated role. Tenant resolved from session, NEVER from the client.
const AskReq = z.object({
  question: z.string().min(1).max(2000),
  conversationId: z.string().uuid().optional(),
});

export async function POST(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");

  const parsed = AskReq.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const rid = session.restaurant.id;
  try {
    const result = await withTenant(rid, (tx) => answer(tx, {
      restaurantId: rid,
      userId: session.user.id,
      restaurantName: session.restaurant.name,
      question: parsed.data.question,
      conversationId: parsed.data.conversationId,
    }));
    return NextResponse.json(result);
  } catch (err) {
    console.error("[/api/ask] failed:", err); // never leak internals/DSN/key
    return errorResponse("INTERNAL", "Failed to answer");
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/api/ask.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**
```bash
git add src/app/api/ask/route.ts test/api/ask.test.ts
git commit -m "Phase 3: POST /api/ask route (auth, validation, grounded AskResponse) (FR-011/FR-013)"
```

---

## Task 8: Seed corpus (`eval/content.ts` + `eval/seed.ts`)

A real, committed demo corpus so all 15 eval questions run. demo-restaurant-a holds the answerable sources + menu; the three fallback questions' sources are deliberately absent. demo-restaurant-b is a small different corpus for isolation.

**Files:**
- Create: `eval/content.ts`
- Create: `eval/seed.ts`
- Modify: `package.json` (add `eval:seed` script)

- [ ] **Step 1: Author the corpus fixtures**

Create `eval/content.ts`. Each `docs` entry is `{ title, text }`; each `menu` entry matches `MenuCardInput` + name. Author realistic content (a few hundred words per doc). **Cover** the non-fallback questions and **omit** the fallback ones (no NA-pairing doc → Q08; no alcohol-service policy → Q13; no wifi → Q15):
```ts
import type { MenuCardInput } from "@/lib/qa/menu-card";

export type SeedDoc = { title: string; text: string };
export type SeedMenu = MenuCardInput & { name: string };

// demo-restaurant-a — the eval's restaurant_scope.
export const RESTAURANT_A = "demo-restaurant-a";
export const DOCS_A: SeedDoc[] = [
  { title: "Wine List", text:
    "By the glass: a Burgundy from the Côte de Beaune, Domaine Example 2019 — bright red cherry, " +
    "forest floor, fine tannins. [...author full notes; covers Q07...]" },
  { title: "Wine Pairing Guide", text:
    "Braised short rib: pair with the Côtes du Rhône Syrah blend — its pepper and dark fruit cut " +
    "the richness. [...covers Q06...]" },
  { title: "Service Standards SOP", text:
    "Presenting and opening wine tableside: present the label to the host, confirm the vintage, " +
    "cut the foil below the lip, ... [...ordered steps; covers Q09...]" },
  { title: "Complaint Handling SOP", text:
    "If a guest is unhappy with an entrée: apologize sincerely, do not argue, notify the manager " +
    "on duty, and offer to re-fire or remove the item per the manager's approval. [...covers Q10...]" },
  { title: "Staff Handbook — Dress & Grooming", text:
    "Front-of-house dress code: pressed black uniform, closed-toe polished shoes, minimal jewelry, " +
    "hair tied back. [...covers Q11...]" },
  { title: "Food Safety — Allergen & Celiac SOP", text:
    "Guest with celiac disease: notify the kitchen before firing, use a clean prep area and dedicated " +
    "utensils to avoid cross-contact, confirm no shared fryer. [...covers Q12...]" },
];

export const MENU_A: SeedMenu[] = [
  { name: "Branzino", description: "Whole Mediterranean sea bass, wood-grilled, lemon and herbs",
    ingredients: ["branzino", "lemon", "olive oil", "herbs"], allergens: ["fish"], dietaryFlags: ["gluten_free"], price: "42.00" },
  { name: "Mushroom Risotto", description: "Arborio rice, wild mushrooms, parmesan",
    ingredients: ["arborio rice", "wild mushrooms", "parmesan", "butter"], allergens: ["milk"], dietaryFlags: ["vegetarian", "gluten_free"], price: "28.00" },
  { name: "Seared Scallops", description: "Pan-seared, citrus beurre blanc",
    ingredients: ["scallops", "butter", "citrus"], allergens: ["shellfish"], dietaryFlags: [], price: "38.00" },
  { name: "Braised Short Rib", description: "Red-wine braised, root vegetables",
    ingredients: ["beef short rib", "red wine", "carrot", "onion"], allergens: [], dietaryFlags: ["gluten_free"], price: "44.00" },
  { name: "Grilled Chicken", description: "Pollo a la parrilla, charred lemon",
    ingredients: ["chicken", "lemon", "olive oil"], allergens: [], dietaryFlags: ["gluten_free"], price: "30.00" },
  { name: "Walnut Endive Salad", description: "Endive, candied walnuts, blue cheese",
    ingredients: ["endive", "walnuts", "blue cheese"], allergens: ["tree_nuts", "milk"], dietaryFlags: ["vegetarian"], price: "18.00" },
  { name: "Almond Tart", description: "Frangipane tart, almond cream",
    ingredients: ["almonds", "butter", "eggs", "flour"], allergens: ["tree_nuts", "milk", "eggs", "wheat"], dietaryFlags: ["vegetarian"], price: "14.00" },
];

// demo-restaurant-b — a small DIFFERENT corpus, purely for the isolation check.
export const RESTAURANT_B = "demo-restaurant-b";
export const DOCS_B: SeedDoc[] = [
  { title: "Taco Service Notes", text:
    "Salsa roja heat levels, tortilla warming, and table-side guacamole prep. [...distinct from A...]" },
];
export const MENU_B: SeedMenu[] = [
  { name: "Carne Asada Taco", description: "Grilled skirt steak, onion, cilantro",
    ingredients: ["skirt steak", "corn tortilla", "onion", "cilantro"], allergens: [], dietaryFlags: ["gluten_free"], price: "6.00" },
];
```
> Flesh out each `[...]` with real prose before running — the fuller the doc, the more honest the retrieval distribution. Keep dish names/flags as above so they map to the eval questions.

- [ ] **Step 2: Write the seeder**

Create `eval/seed.ts`:
```ts
// Idempotent demo-corpus seeder. Runs the REAL chunk + embed path so retrieval sees
// production-shaped chunks. Menu items are rendered to text cards and embedded as chunks
// under a synthetic "Menu" document — the single uniform retrieval path (Phase 3 spec §2).
// Run: npm run eval:seed   (needs a real OPENAI_API_KEY + Docker Postgres up)
import "dotenv/config";
import { inArray } from "drizzle-orm";
import { db, withTenant, pool } from "@/lib/db";
import { restaurants, users, documents, chunks, menuItems } from "@/db/schema";
import { chunk as chunkText } from "@/lib/ingest/chunk";
import { embed } from "@/lib/ai/embeddings";
import { hashPassword } from "@/lib/auth/password";
import { menuCard } from "@/lib/qa/menu-card";
import {
  RESTAURANT_A, DOCS_A, MENU_A, RESTAURANT_B, DOCS_B, MENU_B,
  type SeedDoc, type SeedMenu,
} from "./content";

async function ingestDoc(rid: string, title: string, text: string) {
  const [doc] = await withTenant(rid, (tx) =>
    tx.insert(documents).values({
      restaurantId: rid, title, sourceType: "text",
      contentHash: `seed-${title}-${rid}`, status: "done",
    }).returning());
  const pieces = chunkText(text);
  const { vectors } = await embed(pieces.map((p) => p.text));
  await withTenant(rid, (tx) =>
    tx.insert(chunks).values(pieces.map((p) => ({
      documentId: doc.id, restaurantId: rid, chunkIndex: p.chunkIndex,
      text: p.text, tokenCount: p.tokenCount, embedding: vectors[p.chunkIndex],
    }))));
}

async function ingestMenu(rid: string, items: SeedMenu[]) {
  // The synthetic "Menu" document that owns the menu-card chunks.
  const [menuDoc] = await withTenant(rid, (tx) =>
    tx.insert(documents).values({
      restaurantId: rid, title: "Menu", sourceType: "text",
      contentHash: `seed-menu-${rid}`, status: "done",
    }).returning());
  const cards = items.map((it) => menuCard(it));
  const { vectors } = await embed(cards);
  await withTenant(rid, async (tx) => {
    for (const it of items) {
      await tx.insert(menuItems).values({
        restaurantId: rid, name: it.name, description: it.description,
        ingredients: it.ingredients, allergens: it.allergens as never,
        dietaryFlags: it.dietaryFlags, price: it.price,
      });
    }
    await tx.insert(chunks).values(items.map((_, i) => ({
      documentId: menuDoc.id, restaurantId: rid, chunkIndex: i,
      text: cards[i], tokenCount: Math.max(1, cards[i].split(/\s+/).length), embedding: vectors[i],
    })));
  });
}

async function seedRestaurant(name: string, docs: SeedDoc[], menu: SeedMenu[]) {
  const [r] = await db.insert(restaurants).values({ name }).returning();
  await db.insert(users).values({
    restaurantId: r.id, email: `owner@${name}.test`,
    passwordHash: await hashPassword("x".repeat(12)), role: "owner",
  });
  for (const d of docs) await ingestDoc(r.id, d.title, d.text);
  await ingestMenu(r.id, menu);
  console.log(JSON.stringify({ event: "seed.restaurant", name, id: r.id, docs: docs.length, menu: menu.length }));
}

async function main() {
  // Idempotent: drop prior demo restaurants (cascade clears children), then reseed.
  await db.delete(restaurants).where(inArray(restaurants.name, [RESTAURANT_A, RESTAURANT_B]));
  await seedRestaurant(RESTAURANT_A, DOCS_A, MENU_A);
  await seedRestaurant(RESTAURANT_B, DOCS_B, MENU_B);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Add the `eval:seed` script to `package.json`**

In `scripts`, mirror the worker's `tsx` + worker-tsconfig (aliases `server-only`):
```json
    "eval:seed": "tsx --tsconfig tsconfig.worker.json eval/seed.ts",
```

- [ ] **Step 4: Run the seeder** (needs real `OPENAI_API_KEY` + `docker compose up -d`)

Run: `npm run eval:seed`
Expected: two `seed.restaurant` log lines (A with 7 docs incl. Menu, B with 2). Re-running produces the same end state (idempotent).

- [ ] **Step 5: Commit**
```bash
git add eval/content.ts eval/seed.ts package.json
git commit -m "Phase 3: demo corpus + idempotent seeder (real chunk+embed path)"
```

---

## Task 9: Eval calibration harness (`eval/run.ts`)

Runs all 15 questions through the REAL retrieval/generation code, prints the top-1 similarity distribution (so David picks the threshold), auto-asserts the mechanical guarantees, and runs the isolation check. Side-effect-free (does not persist).

**Files:**
- Create: `eval/run.ts`
- Modify: `package.json` (add `eval:run`; add `yaml` dep)

- [ ] **Step 1: Install the YAML parser**

Run: `npm install yaml`
Expected: `yaml` added to dependencies.

- [ ] **Step 2: Write the harness**

Create `eval/run.ts`:
```ts
// Calibration + verification over eval/eval-set.yaml. Reuses prod retrieve/buildPrompt/
// generate (no drift). Prints the distribution for threshold calibration (rag.md §4) and
// auto-checks fallbacks + isolation. Run: npm run eval:run
import "dotenv/config";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { eq } from "drizzle-orm";
import { db, withTenant, pool } from "@/lib/db";
import { restaurants, users } from "@/db/schema";
import { embed } from "@/lib/ai/embeddings";
import { retrieve } from "@/lib/qa/retrieve";
import { buildPrompt, FALLBACK_TEXT } from "@/lib/qa/prompt";
import { generate } from "@/lib/ai/generate";
import { answer, THRESHOLD } from "@/lib/qa/answer";
import { RESTAURANT_A, RESTAURANT_B } from "./content";

type EvalQ = {
  id: string; question: string; expects_fallback: boolean; safety_critical: boolean;
};

async function restaurantId(name: string): Promise<string> {
  const [r] = await db.select({ id: restaurants.id }).from(restaurants).where(eq(restaurants.name, name)).limit(1);
  if (!r) throw new Error(`${name} not seeded — run npm run eval:seed first`);
  return r.id;
}

async function main() {
  const set = parseYaml(readFileSync("eval/eval-set.yaml", "utf8")) as { questions: EvalQ[] };
  const ridA = await restaurantId(RESTAURANT_A);
  const ridB = await restaurantId(RESTAURANT_B);

  const rows: { id: string; fb: boolean; safety: boolean; top1: number; gate: boolean; topDoc: string; leak: boolean }[] = [];

  for (const q of set.questions) {
    const { vectors } = await embed([q.question]);
    const qEmb = vectors[0];

    const hitsA = await withTenant(ridA, (tx) => retrieve(tx, qEmb, 5));
    const top1 = hitsA[0]?.similarity ?? 0;
    const gate = top1 >= THRESHOLD;

    // Isolation: same question under B must share zero chunkIds with A's hits.
    const hitsB = await withTenant(ridB, (tx) => retrieve(tx, qEmb, 5));
    const aIds = new Set(hitsA.map((h) => h.chunkId));
    const leak = hitsB.some((h) => aIds.has(h.chunkId));

    rows.push({
      id: q.id, fb: q.expects_fallback, safety: q.safety_critical,
      top1: Number(top1.toFixed(4)), gate, topDoc: hitsA[0]?.documentTitle ?? "—", leak,
    });

    // Show the generated answer for human pass_condition scoring on answerable questions.
    if (gate && !q.expects_fallback) {
      const out = await generate(buildPrompt(RESTAURANT_A, hitsA, q.question));
      console.log(`\n[${q.id}] ${q.question}\n  top1=${top1.toFixed(3)} (${rows[rows.length - 1].topDoc})\n  ANSWER: ${out.text}`);
    }
  }

  // ---- Distribution + verdicts -------------------------------------------------
  console.log("\n=== distribution ===");
  for (const r of rows) {
    console.log(`${r.id}  fb=${r.fb ? "Y" : "n"} safety=${r.safety ? "Y" : "n"}  top1=${r.top1.toFixed(4)}  gate=${r.gate ? "PASS" : "decline"}  ${r.topDoc}`);
  }

  const answerable = rows.filter((r) => !r.fb);
  const fallbacks = rows.filter((r) => r.fb);
  const minAnswerable = Math.min(...answerable.map((r) => r.top1));
  const maxFallback = Math.max(...fallbacks.map((r) => r.top1));
  console.log(`\nanswerable min top1 = ${minAnswerable.toFixed(4)}; fallback max top1 = ${maxFallback.toFixed(4)}`);
  console.log(`suggested THRESHOLD ∈ (${maxFallback.toFixed(4)}, ${minAnswerable.toFixed(4)}] — bias UP near safety-critical lines`);

  // ---- Auto-asserts ------------------------------------------------------------
  const fallbackOk = fallbacks.every((r) => !r.gate);                 // all three decline at current THRESHOLD
  const answerableGateOk = answerable.every((r) => r.gate);           // all answerable clear it
  const noLeak = rows.every((r) => !r.leak);                          // zero cross-tenant leaks
  console.log(`\nfallbacks decline: ${fallbackOk ? "PASS" : "FAIL"}`);
  console.log(`answerable clear gate: ${answerableGateOk ? "PASS" : "FAIL"} (judge top-doc relevance by eye for ≥90%)`);
  console.log(`isolation (0 leaks): ${noLeak ? "PASS" : "FAIL"}`);

  // Also exercise the full persisted path once end-to-end (needs a real user for the FK).
  const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.restaurantId, ridA)).limit(1);
  const probe = await withTenant(ridA, (tx) => answer(tx, {
    restaurantId: ridA, userId: owner.id,
    restaurantName: RESTAURANT_A, question: "What's the guest WiFi password?",
  }));
  console.log(`\nend-to-end fallback probe (Q15-style): grounded=${probe.grounded} (expect false), answer="${probe.answer}"`);
  console.log(probe.answer === FALLBACK_TEXT ? "probe PASS" : "probe FAIL");

  await pool.end();
  if (!fallbackOk || !noLeak) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
```
> The probe runs the full persisted `answer()` path once (so generation + persistence are exercised end-to-end against the real corpus), using A's seeded owner for the `messages`/`usage_events` FKs.

- [ ] **Step 3: Add the `eval:run` script to `package.json`**
```json
    "eval:run": "tsx --tsconfig tsconfig.worker.json eval/run.ts",
```

- [ ] **Step 4: Run it** (after `eval:seed`)

Run: `npm run eval:run`
Expected: a distribution table, the answerable answers printed for eyeballing, and three verdicts. At the placeholder `THRESHOLD = 0.35` some assertions may not yet pass — that's expected; Task 10 calibrates.

- [ ] **Step 5: Commit**
```bash
git add eval/run.ts package.json package-lock.json
git commit -m "Phase 3: eval calibration + verification harness (distribution, fallback, isolation)"
```

---

## Task 10: Calibrate the threshold + finalize the prompt — **David's task**

This is where David owns the two values. No new files; tune `answer.ts` + `prompt.ts` against real data.

- [ ] **Step 1: Read the distribution**

Run: `npm run eval:seed && npm run eval:run`
Look at the printed `answerable min top1` vs `fallback max top1` gap and the per-question table.

- [ ] **Step 2: Set the calibrated `THRESHOLD`**

Edit `src/lib/qa/answer.ts`: replace `export const THRESHOLD = 0.35;` with a value inside the gap
`(maxFallback, minAnswerable]`, biased **up** if any safety-critical question (Q02–Q05, Q12, Q14)
sits near the line. Update the comment to record *why* this number (the observed gap).

- [ ] **Step 3: Finalize the prompt wording**

Edit `src/lib/qa/prompt.ts`: rewrite the `system` string and `FALLBACK_TEXT` in your own words,
keeping the four rules intact. Re-read the answers printed by `eval:run` to confirm the allergen
caution actually fires on Q04/Q05/Q12.

- [ ] **Step 4: Re-run to confirm the gates**

Run: `npm run eval:run`
Expected: `fallbacks decline: PASS` · `answerable clear gate: PASS` · `isolation (0 leaks): PASS` ·
`probe PASS`. Eyeball that ≥90% of answerable questions retrieved the right source doc and that no
safety answer asserts "safe" beyond the source.

- [ ] **Step 5: Explain it back** (AI-usage discipline)

Write 3–4 sentences (in the commit body or `docs/rag.md`) justifying the chosen threshold and any
prompt changes — this is the interview/investor answer.

- [ ] **Step 6: Commit**
```bash
git add src/lib/qa/answer.ts src/lib/qa/prompt.ts docs/rag.md
git commit -m "Phase 3: calibrate grounding threshold + finalize prompt against eval set (FR-012/FR-014)"
```

---

## Task 11: Full verification + status update

**Files:**
- Modify: `CLAUDE.md` (Current status), `eval/eval-set.yaml` (optional: bind dish names if you renamed any)

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean (no errors).

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: green; `/api/ask` appears in the route list.

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: all green (the 66 Phase-2 tests + the new Phase-3 unit/integration/RLS tests).

- [ ] **Step 4: DoD checklist (manual, from the spec §9)**

Confirm and note evidence for each: FR-010 isolation (retrieve test + `eval:run` 0 leaks) · FR-011
grounded+cited, key server-only · FR-012 Q08/Q13/Q15 decline (eval) · FR-013 persisted turn (ask test)
· FR-014 safety answers source-backed (eval eyeball) · eval gate (hit-rate ≥90%, fallbacks 100%,
0 leaks) · threshold + prompt finalized.

- [ ] **Step 5: Update `CLAUDE.md` Current status**

Add a "Phase 3 — COMPLETE" block (mirror the Phase 2 block): what shipped, the calibrated threshold
value, test count, and "Next step → Phase 4 (Menu management + menu-aware answers, FR-015–017)".

- [ ] **Step 6: Commit**
```bash
git add CLAUDE.md eval/eval-set.yaml
git commit -m "Phase 3 complete: retrieval + grounded Q&A verified against eval set; next is Phase 4"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** FR-010 (Task 3,9) · FR-011 (Task 2,6,7) · FR-012 (Task 5,6,10) · FR-013 (Task 1,6,7) · FR-014 (Task 4,5,10) · RLS deferral (Task 1) · seed/eval (Task 8,9) · David-owned threshold+prompt (Task 10). No spec section is unmapped.
- **Type consistency:** `ChatMessage` (generate.ts) consumed by prompt.ts + answer.ts; `RetrievedChunk` (retrieve.ts) consumed by prompt.ts + answer.ts; `Source`/`AnswerResult` (answer.ts) is the route's response body; `MenuCardInput` (menu-card.ts) used by content.ts + seed.ts. Names match across tasks.
- **Known gotchas carried from Phase 2:** vitest 4.x constructor mocks need a regular `function` (used in Task 2); module-export mocks use arrow factories (Task 6,7); never edit an applied migration (0004 is new); Docker Postgres must be up for DB tests; `eval:*` scripts use `tsconfig.worker.json` so `server-only` doesn't break under `tsx`.
- **`eval:seed`/`eval:run` hit real OpenAI** (embeddings + one completion per answerable question) — they need a funded `OPENAI_API_KEY`; the vitest suite never does (always mocked).
