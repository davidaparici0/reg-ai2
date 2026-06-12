# Phase 4 — Menu Management + Menu-Aware Answers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manager CRUD for `menu_items` where every write synchronously rebuilds the synthetic Menu document's chunks, so `/api/ask` reflects menu changes the moment the write returns (FR-015–017).

**Architecture:** Four routes (`POST/GET /api/menu-items`, `PATCH/DELETE /api/menu-items/:id`) call one shared `rebuildMenuChunks(tx, rid, userId)` inside the write's tenant transaction: advisory-lock → row write → read active items → render `menuCard()`s → one batched `embed()` → swap chunks. Embed-before-mutate + single tx ⇒ menu rows and chunks can never diverge. The eval seeder refactors onto the same helpers. Zero migrations.

**Tech Stack:** Next.js 16 Route Handlers, Drizzle + `pg` (`withTenant` RLS pattern), Zod, OpenAI `text-embedding-3-small` behind `src/lib/ai/embeddings.ts`, vitest (OpenAI always mocked; Docker Postgres for DB/RLS tests).

**Branch:** work on `phase-4-menu-management` off `main`. Spec: `docs/superpowers/specs/2026-06-12-phase-4-menu-management-design.md`.

**House rules that bind every task here:**
- Roles are `trainee|manager|owner`; gate writes with `hasRole(session.user.role, "manager")`.
- Error envelope ONLY via `errorResponse(code, message, details?)` from `src/lib/http/errors.ts`.
- Foreign-tenant/missing/non-uuid ids → `404` (anti-enumeration; RLS hides rows — same as `GET /api/documents/:id`).
- Tests never call OpenAI: `vi.hoisted` + `vi.mock("@/lib/ai/embeddings", ...)` BEFORE importing the module under test (see `test/api/ask.test.ts`).
- Docker Postgres must be up for DB tests (`docker compose up -d`).

---

### Task 1: Zod validation module (`src/lib/menu/validate.ts`)

**Files:**
- Create: `src/lib/menu/validate.ts`
- Test: `test/lib/menu-validate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/lib/menu-validate.test.ts
import { describe, expect, it } from "vitest";
import { CreateMenuItem, PatchMenuItem, priceToDb } from "@/lib/menu/validate";

describe("CreateMenuItem", () => {
  it("accepts a full valid item and lowercases dietary flags", () => {
    const r = CreateMenuItem.safeParse({
      name: "  Branzino ", description: "Whole sea bass", ingredients: ["branzino", "lemon"],
      allergens: ["fish"], dietaryFlags: ["Gluten_Free"], price: 42.5, active: true,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe("Branzino");          // trimmed
      expect(r.data.dietaryFlags).toEqual(["gluten_free"]); // lowercased transform
    }
  });

  it("requires name and applies defaults-by-absence for the rest", () => {
    expect(CreateMenuItem.safeParse({ name: "Soup" }).success).toBe(true);
    expect(CreateMenuItem.safeParse({}).success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(CreateMenuItem.safeParse({ name: "Soup", spicy: true }).success).toBe(false);
  });

  it("rejects allergens outside the DB vocabulary", () => {
    expect(CreateMenuItem.safeParse({ name: "Soup", allergens: ["gluten"] }).success).toBe(false);
  });

  it("rejects dietary flags that are not lowercase tokens after transform", () => {
    expect(CreateMenuItem.safeParse({ name: "Soup", dietaryFlags: ["has space"] }).success).toBe(false);
    expect(CreateMenuItem.safeParse({ name: "Soup", dietaryFlags: [""] }).success).toBe(false);
  });

  it("price: >=0, max 2 decimals", () => {
    expect(CreateMenuItem.safeParse({ name: "Soup", price: 12.5 }).success).toBe(true);
    expect(CreateMenuItem.safeParse({ name: "Soup", price: 12.555 }).success).toBe(false);
    expect(CreateMenuItem.safeParse({ name: "Soup", price: -1 }).success).toBe(false);
  });
});

describe("PatchMenuItem", () => {
  it("requires at least one field", () => {
    expect(PatchMenuItem.safeParse({}).success).toBe(false);
  });
  it("allows null to clear nullable fields, but not name", () => {
    expect(PatchMenuItem.safeParse({ description: null }).success).toBe(true);
    expect(PatchMenuItem.safeParse({ name: null }).success).toBe(false);
  });
  it("allows a lone active toggle", () => {
    expect(PatchMenuItem.safeParse({ active: false }).success).toBe(true);
  });
});

describe("priceToDb", () => {
  it("maps number to 2dp string, passes null/undefined through", () => {
    expect(priceToDb(12.5)).toBe("12.50");
    expect(priceToDb(null)).toBeNull();
    expect(priceToDb(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/menu-validate.test.ts`
Expected: FAIL — `Cannot find module '@/lib/menu/validate'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/menu/validate.ts
// Request validation for /api/menu-items (Phase 4 spec §5). One base object; POST and
// PATCH derive from it so field rules can't drift. allergens reuses the DB enum values
// (schema.ts) — the controlled vocabulary IS the contract (a free-text allergen is a
// wrong safety answer waiting to happen).
import { z } from "zod";
import { allergen } from "@/db/schema";

// Lowercase+trim is a TRANSFORM (we normalize), the regex then VALIDATES the result.
const dietaryFlag = z.string().trim().toLowerCase()
  .pipe(z.string().regex(/^[a-z0-9_]{1,32}$/, "lowercase letters, digits, underscore (1-32 chars)"));

// String(p) renders plain decimal notation for any realistic price, so the regex is a
// reliable "max 2 decimals" check without float-modulo pitfalls (0.07 % 0.01 !== 0).
const price = z.number().min(0).max(100_000)
  .refine((p) => /^\d+(\.\d{1,2})?$/.test(String(p)), "at most 2 decimal places");

const base = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable(),
  ingredients: z.array(z.string().trim().min(1).max(100)).max(100).nullable(),
  allergens: z.array(z.enum(allergen.enumValues)).max(20).nullable(),
  dietaryFlags: z.array(dietaryFlag).max(20).nullable(),
  price: price.nullable(),
  active: z.boolean(),
});

// POST: name required; everything else optional (absent => DB default / null).
export const CreateMenuItem = base.partial().required({ name: true }).strict();
// PATCH: any subset, at least one key; name stays non-nullable.
export const PatchMenuItem = base.partial().strict()
  .refine((o) => Object.keys(o).length > 0, { message: "At least one field is required" });

export type CreateMenuItemInput = z.infer<typeof CreateMenuItem>;
export type PatchMenuItemInput = z.infer<typeof PatchMenuItem>;

// drizzle numeric columns take strings; keep absent (undefined) vs clear (null) distinct.
export const priceToDb = (p: number | null | undefined): string | null | undefined =>
  p == null ? p : p.toFixed(2);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/menu-validate.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/menu/validate.ts test/lib/menu-validate.test.ts
git commit -m "Phase 4: menu-item request validation (shared base, allergen vocab from schema) (FR-015)"
```

---

### Task 2: Rebuild module (`src/lib/menu/rebuild.ts`) — the FR-017 heart

**Files:**
- Create: `src/lib/menu/rebuild.ts`
- Test: `test/lib/menu-rebuild.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/lib/menu-rebuild.test.ts
// DB test (Docker Postgres). Embeddings mocked — vectors are deterministic basis vectors.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { embedMock } = vi.hoisted(() => ({ embedMock: vi.fn() }));
vi.mock("@/lib/ai/embeddings", () => ({
  embed: embedMock, embeddingCostUsd: (t: number) => t * 1e-8,
  EMBEDDING_MODEL: "text-embedding-3-small", EMBEDDING_DIM: 1536,
}));

import { eq, and, asc } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { documents, chunks, menuItems, usageEvents } from "@/db/schema";
import { ensureMenuDocument, lockMenuRebuild, rebuildMenuChunks, menuDocContentHash } from "@/lib/menu/rebuild";
import { registerOwner } from "../helpers/auth";
import { cleanup } from "../helpers/db";

afterEach(cleanup);
beforeEach(() => {
  embedMock.mockReset();
  // Return one distinct basis vector per input card, in order.
  embedMock.mockImplementation(async (texts: string[]) => ({
    vectors: texts.map((_, i) => { const v = Array(1536).fill(0); v[i] = 1; return v; }),
    usageTokens: texts.length * 10,
  }));
});

async function insertItem(rid: string, name: string, active = true) {
  return withTenant(rid, (tx) =>
    tx.insert(menuItems).values({ restaurantId: rid, name, active }).returning());
}

describe("rebuildMenuChunks", () => {
  it("creates the Menu doc on first run and one chunk per active item, name-ordered", async () => {
    const { restaurant, user } = await registerOwner();
    await insertItem(restaurant.id, "Zucchini Tart");
    await insertItem(restaurant.id, "Apple Salad");

    await withTenant(restaurant.id, async (tx) => {
      await lockMenuRebuild(tx, restaurant.id);
      await rebuildMenuChunks(tx, restaurant.id, user.id);
    });

    const [doc] = await withTenant(restaurant.id, (tx) =>
      tx.select().from(documents)
        .where(and(eq(documents.restaurantId, restaurant.id),
                   eq(documents.contentHash, menuDocContentHash(restaurant.id)))));
    expect(doc).toBeDefined();
    expect(doc.title).toBe("Menu");
    expect(doc.status).toBe("done");

    const rows = await withTenant(restaurant.id, (tx) =>
      tx.select().from(chunks).where(eq(chunks.documentId, doc.id)).orderBy(asc(chunks.chunkIndex)));
    expect(rows).toHaveLength(2);
    expect(rows[0].chunkIndex).toBe(0);
    expect(rows[0].text.startsWith("Dish: Apple Salad.")).toBe(true);   // name asc
    expect(rows[1].text.startsWith("Dish: Zucchini Tart.")).toBe(true);

    const usage = await withTenant(restaurant.id, (tx) =>
      tx.select().from(usageEvents).where(eq(usageEvents.restaurantId, restaurant.id)));
    expect(usage.some((u) => u.kind === "embedding" && u.userId === user.id)).toBe(true);
  });

  it("is idempotent + deterministic: a second rebuild replaces the set with identical cards", async () => {
    const { restaurant, user } = await registerOwner();
    await insertItem(restaurant.id, "Soup");
    const run = () => withTenant(restaurant.id, async (tx) => {
      await lockMenuRebuild(tx, restaurant.id);
      await rebuildMenuChunks(tx, restaurant.id, user.id);
    });
    const doc = await withTenant(restaurant.id, async (tx) =>
      ensureMenuDocument(tx, restaurant.id));
    const texts = () => withTenant(restaurant.id, (tx) =>
      tx.select({ text: chunks.text }).from(chunks)
        .where(eq(chunks.documentId, doc.id)).orderBy(asc(chunks.chunkIndex)));
    await run();
    const first = await texts();
    await run();
    const second = await texts();
    expect(second).toHaveLength(1);            // replaced, not duplicated
    expect(second).toEqual(first);             // same items => byte-identical card list (spec §7)
  });

  it("inactive items get no card; zero active items embeds nothing", async () => {
    const { restaurant, user } = await registerOwner();
    await insertItem(restaurant.id, "Eighty-Sixed", false);
    await withTenant(restaurant.id, async (tx) => {
      await lockMenuRebuild(tx, restaurant.id);
      await rebuildMenuChunks(tx, restaurant.id, user.id);
    });
    const doc = await withTenant(restaurant.id, async (tx) =>
      ensureMenuDocument(tx, restaurant.id));
    const rows = await withTenant(restaurant.id, (tx) =>
      tx.select().from(chunks).where(eq(chunks.documentId, doc.id)));
    expect(rows).toHaveLength(0);
    expect(embedMock).not.toHaveBeenCalled(); // embed([]) short-circuit is upstream; with 0 cards we never call it
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose up -d && npx vitest run test/lib/menu-rebuild.test.ts`
Expected: FAIL — `Cannot find module '@/lib/menu/rebuild'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/menu/rebuild.ts
// FR-017: a menu write ends by rebuilding the synthetic Menu document's chunks INSIDE the
// same tenant transaction. Embed happens BEFORE any chunk mutation, so an OpenAI failure
// aborts the whole tx (row write included) and the menu can never diverge from its chunks.
// Callers MUST take lockMenuRebuild() first: it serializes concurrent menu writes per
// tenant so two simultaneous edits can't each rebuild from a snapshot missing the other.
import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { chunks, documents, menuItems, usageEvents } from "@/db/schema";
import { embed, embeddingCostUsd, EMBEDDING_MODEL } from "@/lib/ai/embeddings";
import { menuCard } from "@/lib/qa/menu-card";

export const MENU_DOC_TITLE = "Menu";
// Well-known content_hash locates the one synthetic Menu doc per tenant (documents has a
// unique (restaurant_id, content_hash) constraint, so there can never be two).
export const menuDocContentHash = (restaurantId: string) => `menu:${restaurantId}`;

// pg_advisory_xact_lock: transaction-scoped, auto-released on commit/rollback.
// hashtextextended(text, seed) -> bigint key; namespaced so only MENU writes contend.
export async function lockMenuRebuild(tx: Tx, restaurantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"menu:" + restaurantId}, 0))`);
}

export async function ensureMenuDocument(tx: Tx, restaurantId: string): Promise<{ id: string }> {
  const hash = menuDocContentHash(restaurantId);
  const [existing] = await tx.select({ id: documents.id }).from(documents)
    .where(and(eq(documents.restaurantId, restaurantId), eq(documents.contentHash, hash)))
    .limit(1);
  if (existing) return existing;
  const [created] = await tx.insert(documents).values({
    restaurantId, title: MENU_DOC_TITLE, sourceType: "text", contentHash: hash, status: "done",
  }).returning({ id: documents.id });
  return created;
}

// Full-menu rebuild (Approach A, spec §2.4): tens of short cards => one bounded embed
// call (~$0.0001). Deterministic card order (name, id) keeps rebuilds reproducible.
// userId: the acting user for usage attribution; null for system paths (seeder).
export async function rebuildMenuChunks(
  tx: Tx, restaurantId: string, userId: string | null,
): Promise<{ cardCount: number }> {
  const items = await tx.select().from(menuItems)
    .where(and(eq(menuItems.restaurantId, restaurantId), eq(menuItems.active, true)))
    .orderBy(asc(menuItems.name), asc(menuItems.id));
  const cards = items.map((it) => menuCard(it));

  const doc = await ensureMenuDocument(tx, restaurantId);

  // Embed FIRST (no DB state touched yet). Skip the call entirely for an empty menu —
  // zero cards must mean zero API risk (and the tests assert embed is never invoked).
  const { vectors, usageTokens } = cards.length
    ? await embed(cards)
    : { vectors: [] as number[][], usageTokens: 0 };

  await tx.delete(chunks).where(eq(chunks.documentId, doc.id));
  if (cards.length) {
    await tx.insert(chunks).values(cards.map((text, i) => ({
      documentId: doc.id, restaurantId, chunkIndex: i, text,
      // Whitespace-token approximation, same as the seeder used — tokenCount on menu
      // cards is bookkeeping, not billing (billing uses the API's usageTokens below).
      tokenCount: Math.max(1, text.split(/\s+/).length),
      embedding: vectors[i],
    })));
  }

  if (usageTokens > 0) {
    await tx.insert(usageEvents).values({
      restaurantId, userId, kind: "embedding", model: EMBEDDING_MODEL,
      inputTokens: usageTokens, outputTokens: 0,
      costUsd: embeddingCostUsd(usageTokens).toFixed(6),
    });
  }
  return { cardCount: cards.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/menu-rebuild.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/menu/rebuild.ts test/lib/menu-rebuild.test.ts
git commit -m "Phase 4: menu chunk rebuild — advisory-locked, embed-before-mutate, name-ordered cards (FR-017)"
```

---

### Task 3: `EMBED_FAILED` error code + collection routes (`POST` / `GET /api/menu-items`)

**Files:**
- Modify: `src/lib/http/errors.ts` (add one code)
- Create: `src/app/api/menu-items/route.ts`
- Test: `test/api/menu-items.test.ts` (collection half)

- [ ] **Step 1: Add `EMBED_FAILED` to the error envelope**

In `src/lib/http/errors.ts`, change the two definitions to:

```typescript
export type ErrorCode =
  | "VALIDATION_ERROR" | "UNAUTHENTICATED" | "FORBIDDEN"
  | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" | "INTERNAL" | "EMBED_FAILED";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403,
  NOT_FOUND: 404, CONFLICT: 409, RATE_LIMITED: 429, INTERNAL: 500, EMBED_FAILED: 502,
};
```

- [ ] **Step 2: Write the failing tests (collection routes)**

```typescript
// test/api/menu-items.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { embedMock } = vi.hoisted(() => ({ embedMock: vi.fn() }));
vi.mock("@/lib/ai/embeddings", () => ({
  embed: embedMock, embeddingCostUsd: (t: number) => t * 1e-8,
  EMBEDDING_MODEL: "text-embedding-3-small", EMBEDDING_DIM: 1536,
}));

import { eq, and, asc } from "drizzle-orm";
import { POST, GET } from "@/app/api/menu-items/route";
import { withTenant } from "@/lib/db";
import { documents, chunks, menuItems } from "@/db/schema";
import { menuDocContentHash } from "@/lib/menu/rebuild";
import { registerOwner, makeUserCookie } from "../helpers/auth";
import { cleanup } from "../helpers/db";

afterEach(cleanup);
beforeEach(() => {
  embedMock.mockReset();
  embedMock.mockImplementation(async (texts: string[]) => ({
    vectors: texts.map((_, i) => { const v = Array(1536).fill(0); v[i] = 1; return v; }),
    usageTokens: texts.length * 10,
  }));
});

const post = (cookie: string | null, body: unknown) =>
  POST(new Request("http://x/api/menu-items", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }));
const list = (cookie: string | null, qs = "") =>
  GET(new Request(`http://x/api/menu-items${qs}`, { headers: cookie ? { cookie } : {} }));

async function menuChunks(rid: string) {
  return withTenant(rid, async (tx) => {
    const [doc] = await tx.select({ id: documents.id }).from(documents)
      .where(and(eq(documents.restaurantId, rid), eq(documents.contentHash, menuDocContentHash(rid))))
      .limit(1);
    if (!doc) return [];
    return tx.select().from(chunks).where(eq(chunks.documentId, doc.id)).orderBy(asc(chunks.chunkIndex));
  });
}

describe("POST /api/menu-items", () => {
  it("401 without a session; 403 for trainee; trainee GET is allowed", async () => {
    expect((await post(null, { name: "Soup" })).status).toBe(401);
    const { cookie, restaurant } = await registerOwner();
    const trainee = await makeUserCookie(restaurant.id, "trainee");
    expect((await post(trainee.cookie, { name: "Soup" })).status).toBe(403);
    expect((await list(trainee.cookie)).status).toBe(200);
    void cookie;
  });

  it("400 on invalid bodies", async () => {
    const { cookie } = await registerOwner();
    expect((await post(cookie, { name: "" })).status).toBe(400);
    expect((await post(cookie, { name: "Soup", allergens: ["gluten"] })).status).toBe(400);
    expect((await post(cookie, { name: "Soup", unknown: 1 })).status).toBe(400);
  });

  it("201 creates the item AND its menu card chunk immediately (FR-017)", async () => {
    const { cookie, restaurant } = await registerOwner();
    const res = await post(cookie, {
      name: "Seared Scallops", ingredients: ["scallops", "butter"],
      allergens: ["shellfish", "milk"], price: 36,
    });
    expect(res.status).toBe(201);
    const { menuItem } = await res.json();
    expect(menuItem.name).toBe("Seared Scallops");
    expect(menuItem.price).toBe("36.00"); // numeric -> string

    const rows = await menuChunks(restaurant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain("Dish: Seared Scallops.");
    expect(rows[0].text).toContain("shellfish, milk");
  });

  it("second create keeps cards name-ordered with contiguous indexes", async () => {
    const { cookie, restaurant } = await registerOwner();
    await post(cookie, { name: "Zucchini Tart" });
    await post(cookie, { name: "Apple Salad" });
    const rows = await menuChunks(restaurant.id);
    expect(rows.map((r) => r.chunkIndex)).toEqual([0, 1]);
    expect(rows[0].text.startsWith("Dish: Apple Salad.")).toBe(true);
  });

  it("ATOMIC: embed failure rolls back the row write and keeps old chunks (502)", async () => {
    const { cookie, restaurant } = await registerOwner();
    await post(cookie, { name: "Keeper" });                  // healthy first write
    embedMock.mockRejectedValueOnce(new Error("openai down"));
    const res = await post(cookie, { name: "Doomed" });
    expect(res.status).toBe(502);

    const items = await withTenant(restaurant.id, (tx) => tx.select().from(menuItems));
    expect(items.map((i) => i.name)).toEqual(["Keeper"]);    // Doomed row rolled back
    const rows = await menuChunks(restaurant.id);
    expect(rows).toHaveLength(1);                            // old chunk set intact
    expect(rows[0].text).toContain("Dish: Keeper.");
  });
});

describe("GET /api/menu-items", () => {
  it("lists own items only (isolation), newest-first, includes inactive", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    await post(a.cookie, { name: "A dish", active: false });
    const resB = await list(b.cookie);
    expect((await resB.json()).items).toHaveLength(0);
    const resA = await list(a.cookie);
    const bodyA = await resA.json();
    expect(bodyA.items).toHaveLength(1);
    expect(bodyA.items[0].active).toBe(false);               // inactive listed for managers
    expect(bodyA.nextCursor).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/api/menu-items.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/menu-items/route'`

- [ ] **Step 4: Write the implementation**

```typescript
// src/app/api/menu-items/route.ts
// POST (create) + GET (list) — FR-015. Writes are owner|manager; reads any authenticated
// role (RLS-scoped; trainees may browse). Every write runs the FR-017 rebuild inside the
// same tenant tx, behind the per-tenant advisory lock.
import { NextResponse } from "next/server";
import { desc, lt } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { menuItems } from "@/db/schema";
import { requireSession, hasRole } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { CreateMenuItem, priceToDb } from "@/lib/menu/validate";
import { lockMenuRebuild, rebuildMenuChunks } from "@/lib/menu/rebuild";

const PAGE_SIZE = 20;

export async function POST(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");

  let body: unknown;
  try { body = await req.json(); }
  catch { return errorResponse("VALIDATION_ERROR", "Expected a JSON body"); }
  const parsed = CreateMenuItem.safeParse(body);
  if (!parsed.success) return errorResponse("VALIDATION_ERROR", "Invalid menu item", parsed.error.flatten());

  const rid = session.restaurant.id;
  const input = parsed.data;
  try {
    const item = await withTenant(rid, async (tx) => {
      await lockMenuRebuild(tx, rid);
      const [row] = await tx.insert(menuItems).values({
        restaurantId: rid,
        name: input.name,
        description: input.description ?? null,
        ingredients: input.ingredients ?? null,
        allergens: input.allergens ?? null,
        dietaryFlags: input.dietaryFlags ?? null,
        price: priceToDb(input.price) ?? null,
        ...(input.active === undefined ? {} : { active: input.active }),
      }).returning();
      await rebuildMenuChunks(tx, rid, session.user.id);
      return row;
    });
    return NextResponse.json({ menuItem: item }, { status: 201 });
  } catch (err) {
    // The tx rolled back (row included) — honest, retryable failure. Overwhelmingly the
    // embed call; a DB failure lands here too and the message stays true (nothing changed).
    console.error("menu-items POST rebuild failed:", err);
    return errorResponse("EMBED_FAILED", "Menu embedding failed; nothing was changed. Retry the request.");
  }
}

// GET — any authenticated role. Same cursor idiom as GET /api/documents (created_at desc).
// Includes inactive items: managers must see what's 86'd; invisibility is a Q&A property.
export async function GET(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");

  const cursor = new URL(req.url).searchParams.get("cursor");
  const rows = await withTenant(session.restaurant.id, (tx) =>
    tx.select().from(menuItems)
      .where(cursor ? lt(menuItems.createdAt, new Date(cursor)) : undefined)
      .orderBy(desc(menuItems.createdAt))
      .limit(PAGE_SIZE + 1));

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  return NextResponse.json({
    items: page,
    nextCursor: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/api/menu-items.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add src/lib/http/errors.ts src/app/api/menu-items/route.ts test/api/menu-items.test.ts
git commit -m "Phase 4: POST/GET /api/menu-items — create rebuilds chunks atomically; 502 EMBED_FAILED on rollback (FR-015/FR-017)"
```

---

### Task 4: Item routes (`PATCH` / `DELETE /api/menu-items/:id`)

**Files:**
- Create: `src/app/api/menu-items/[id]/route.ts`
- Test: `test/api/menu-items.test.ts` (append the item-route describe blocks)

- [ ] **Step 1: Append the failing tests**

Append to `test/api/menu-items.test.ts`:

```typescript
import { PATCH, DELETE } from "@/app/api/menu-items/[id]/route";

const patch = (cookie: string | null, id: string, body: unknown) =>
  PATCH(new Request(`http://x/api/menu-items/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
const del = (cookie: string | null, id: string) =>
  DELETE(new Request(`http://x/api/menu-items/${id}`, {
    method: "DELETE", headers: cookie ? { cookie } : {},
  }), { params: Promise.resolve({ id }) });

describe("PATCH /api/menu-items/:id", () => {
  it("400 on an empty patch; 403 for trainee", async () => {
    const { cookie, restaurant } = await registerOwner();
    const created = await (await post(cookie, { name: "Soup" })).json();
    expect((await patch(cookie, created.menuItem.id, {})).status).toBe(400);
    const trainee = await makeUserCookie(restaurant.id, "trainee");
    expect((await patch(trainee.cookie, created.menuItem.id, { name: "X" })).status).toBe(403);
  });

  it("updates fields and swaps the card immediately (FR-017 demo path)", async () => {
    const { cookie, restaurant } = await registerOwner();
    const created = await (await post(cookie, { name: "Grilled Chicken", allergens: null })).json();
    const res = await patch(cookie, created.menuItem.id, { allergens: ["sesame"] });
    expect(res.status).toBe(200);
    const rows = await menuChunks(restaurant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain("Allergens (recorded): sesame.");
  });

  it("active=false removes the card; active=true restores it", async () => {
    const { cookie, restaurant } = await registerOwner();
    const created = await (await post(cookie, { name: "Soup" })).json();
    await patch(cookie, created.menuItem.id, { active: false });
    expect(await menuChunks(restaurant.id)).toHaveLength(0);
    await patch(cookie, created.menuItem.id, { active: true });
    expect(await menuChunks(restaurant.id)).toHaveLength(1);
  });

  it("404 for foreign-tenant, missing, and non-uuid ids (anti-enumeration)", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    const created = await (await post(a.cookie, { name: "Soup" })).json();
    expect((await patch(b.cookie, created.menuItem.id, { name: "Steal" })).status).toBe(404);
    expect((await patch(a.cookie, crypto.randomUUID(), { name: "X" })).status).toBe(404);
    expect((await patch(a.cookie, "not-a-uuid", { name: "X" })).status).toBe(404);
    // and the foreign write changed nothing:
    const rows = await menuChunks(a.restaurant.id);
    expect(rows[0].text).toContain("Dish: Soup.");
  });
});

describe("DELETE /api/menu-items/:id", () => {
  it("204 deletes the row and its card; foreign id 404s", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    const created = await (await post(a.cookie, { name: "Soup" })).json();
    expect((await del(b.cookie, created.menuItem.id)).status).toBe(404);
    const res = await del(a.cookie, created.menuItem.id);
    expect(res.status).toBe(204);
    const items = await withTenant(a.restaurant.id, (tx) => tx.select().from(menuItems));
    expect(items).toHaveLength(0);
    expect(await menuChunks(a.restaurant.id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/api/menu-items.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/menu-items/[id]/route'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/app/api/menu-items/[id]/route.ts
// PATCH (partial update incl. the 86-tonight active toggle) + DELETE (hard) — FR-015.
// Foreign/missing/non-uuid ids -> 404 (RLS hides foreign rows; anti-enumeration, same as
// GET /api/documents/:id). Both writes rebuild the menu chunks in-tx (FR-017).
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { menuItems } from "@/db/schema";
import { requireSession, hasRole } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { PatchMenuItem, priceToDb } from "@/lib/menu/validate";
import { lockMenuRebuild, rebuildMenuChunks } from "@/lib/menu/rebuild";

const Uuid = z.string().uuid();

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");

  const { id } = await ctx.params;
  if (!Uuid.safeParse(id).success) return errorResponse("NOT_FOUND", "Menu item not found");

  let body: unknown;
  try { body = await req.json(); }
  catch { return errorResponse("VALIDATION_ERROR", "Expected a JSON body"); }
  const parsed = PatchMenuItem.safeParse(body);
  if (!parsed.success) return errorResponse("VALIDATION_ERROR", "Invalid menu item patch", parsed.error.flatten());

  const rid = session.restaurant.id;
  const input = parsed.data;
  try {
    const updated = await withTenant(rid, async (tx) => {
      await lockMenuRebuild(tx, rid);
      const [row] = await tx.update(menuItems).set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.ingredients !== undefined ? { ingredients: input.ingredients } : {}),
        ...(input.allergens !== undefined ? { allergens: input.allergens } : {}),
        ...(input.dietaryFlags !== undefined ? { dietaryFlags: input.dietaryFlags } : {}),
        ...(input.price !== undefined ? { price: priceToDb(input.price) } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      }).where(eq(menuItems.id, id)).returning();
      if (!row) return null;                       // RLS hid it (foreign) or missing
      await rebuildMenuChunks(tx, rid, session.user.id);
      return row;
    });
    if (!updated) return errorResponse("NOT_FOUND", "Menu item not found");
    return NextResponse.json({ menuItem: updated });
  } catch (err) {
    console.error("menu-items PATCH rebuild failed:", err);
    return errorResponse("EMBED_FAILED", "Menu embedding failed; nothing was changed. Retry the request.");
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");

  const { id } = await ctx.params;
  if (!Uuid.safeParse(id).success) return errorResponse("NOT_FOUND", "Menu item not found");

  const rid = session.restaurant.id;
  try {
    const deleted = await withTenant(rid, async (tx) => {
      await lockMenuRebuild(tx, rid);
      const [row] = await tx.delete(menuItems).where(eq(menuItems.id, id)).returning({ id: menuItems.id });
      if (!row) return null;
      await rebuildMenuChunks(tx, rid, session.user.id);
      return row;
    });
    if (!deleted) return errorResponse("NOT_FOUND", "Menu item not found");
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error("menu-items DELETE rebuild failed:", err);
    return errorResponse("EMBED_FAILED", "Menu embedding failed; nothing was changed. Retry the request.");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/api/menu-items.test.ts`
Expected: PASS (all collection + item tests)

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/menu-items/[id]/route.ts" test/api/menu-items.test.ts
git commit -m "Phase 4: PATCH/DELETE /api/menu-items/:id — 86-toggle + hard delete, anti-enumeration 404s (FR-015/FR-017)"
```

---

### Task 5: Seeder refactors onto the rebuild helpers (one rendering path)

**Files:**
- Modify: `eval/seed.ts` (the `ingestMenu` function + imports)

- [ ] **Step 1: Replace `ingestMenu` and drop the now-unused import**

In `eval/seed.ts`:
1. Delete the `import { menuCard } from "@/lib/qa/menu-card";` line.
2. Add `import { rebuildMenuChunks } from "@/lib/menu/rebuild";` after the embeddings import.
3. Replace the entire `ingestMenu` function with:

```typescript
async function ingestMenu(rid: string, items: SeedMenu[]) {
  // Same path as the Phase 4 routes: insert rows, then rebuild cards+chunks in-tx.
  // (No advisory lock needed — the seeder is single-writer by construction.)
  await withTenant(rid, async (tx) => {
    for (const it of items) {
      await tx.insert(menuItems).values({
        restaurantId: rid, name: it.name, description: it.description,
        ingredients: it.ingredients, allergens: it.allergens as never,
        dietaryFlags: it.dietaryFlags, price: it.price,
      });
    }
    await rebuildMenuChunks(tx, rid, null); // null user: system/seed attribution
  });
}
```

4. The `documents`/`chunks` imports stay (still used by `ingestDoc`); `embed` stays (used by `ingestDoc`).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Full vitest (regression)**

Run: `npx vitest run`
Expected: all green (83 existing + the new Phase 4 tests)

- [ ] **Step 4: Commit**

```bash
git add eval/seed.ts
git commit -m "Phase 4: seeder reuses rebuildMenuChunks — one menu rendering path, no drift"
```

---

### Task 6: Eval regression (REAL OpenAI — needs funded `OPENAI_API_KEY` + Docker up)

**Files:** none modified — verification only.

- [ ] **Step 1: Reseed through the new path**

Run: `npm run eval:seed`
Expected: two `seed.restaurant` JSON lines (A: 6 docs + 7 menu, B: 1 + 1), no errors.

- [ ] **Step 2: Run the eval gates**

Run: `npm run eval:run`
Expected — all four verdicts, exit code 0:
- `fallbacks decline: PASS (gate: Q13,Q15; model: Q08)`
- `answerable clear gate: PASS`
- `isolation (0 leaks): PASS`
- `probe PASS`

Menu canaries to eyeball: Q01/Q02/Q04/Q14 answers still cite the Menu doc. If a menu
question's top1 moved, that's expected drift from identical re-embedding only if tiny
(±0.001); larger moves mean the card text changed — investigate before proceeding.

- [ ] **Step 3: FR-017 live demo (the acceptance moment)**

With `npm run dev` running in another terminal:

```bash
# 1. Log in as the seeded demo owner (cookie jar)
curl -s -c /tmp/regai.jar -H 'content-type: application/json' \
  -d '{"email":"owner@demo-restaurant-a.test","password":"xxxxxxxxxxxx"}' \
  http://localhost:3000/api/auth/login

# 2. Find the Grilled Chicken item id
curl -s -b /tmp/regai.jar http://localhost:3000/api/menu-items | python3 -c \
  'import json,sys; print([i["id"] for i in json.load(sys.stdin)["items"] if i["name"]=="Grilled Chicken"][0])'

# 3. PATCH: record sesame on it
curl -s -b /tmp/regai.jar -X PATCH -H 'content-type: application/json' \
  -d '{"allergens":["sesame"]}' http://localhost:3000/api/menu-items/<ID>

# 4. Ask immediately — the answer must cite sesame
curl -s -b /tmp/regai.jar -H 'content-type: application/json' \
  -d '{"question":"What allergens does the grilled chicken have?"}' \
  http://localhost:3000/api/ask
```

Expected: step 4's `answer` names **sesame** with a citation and `grounded: true` —
menu change reflected with no re-upload, no worker, no wait (FR-017 ✓).
Then restore: re-run step 1's seed (`npm run eval:seed`) OR PATCH the allergens back to
the seeded value so the eval corpus stays canonical.

- [ ] **Step 4: Commit nothing** — this task produces evidence, not code. Note the demo output for the Task 7 status update.

---

### Task 7: Full verification + docs + status

**Files:**
- Modify: `docs/api.md` (replace the deferred menu row), `CLAUDE.md` (status + phase marker)

- [ ] **Step 1: Typecheck + full tests + build**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: clean · all green · build green with `/api/menu-items` and `/api/menu-items/[id]` in the route list.

- [ ] **Step 2: Update `docs/api.md`**

Replace the deferred-decision row (`| Menu CRUD (\`/api/menu-items\`) | 4 | Shape depends on how menu data feeds retrieval — a Phase 4 decision |`) with a short section documenting the four endpoints: methods, roles (writes owner|manager, reads any authenticated), body fields (mirror spec §5 table), responses (`201 {menuItem}` / `200 {items, nextCursor}` / `200 {menuItem}` / `204`), error codes incl. `502 EMBED_FAILED` (write rolled back, retry), and the note "every write synchronously rebuilds the Menu document's chunks (FR-017)".

- [ ] **Step 3: Update `CLAUDE.md`**

Mirror the Phase 3 block style: add a "**Phase 4 — COMPLETE.**" block (routes, the
rebuild mechanism + advisory lock, atomicity, seeder unification, test count, eval gates
re-verified, the FR-017 demo evidence), move the `◀ CURRENT` marker from Phase 4 to
Phase 5 (mark Phase 4 ✅ DONE), and set "Next step → Phase 5 (Training modules +
progress, FR-018–020)".

- [ ] **Step 4: Commit**

```bash
git add docs/api.md CLAUDE.md
git commit -m "Phase 4 complete: menu CRUD + immediate menu-aware answers verified; next is Phase 5"
```

- [ ] **Step 5: Merge** (after user approval — finishing-a-development-branch skill)

```bash
git checkout main && git pull && git merge --no-ff phase-4-menu-management -m "Merge Phase 4: menu management + menu-aware answers (FR-015–017)"
npx vitest run   # verify on merged result
git branch -d phase-4-menu-management
```

---

## Self-review notes (for the executor)

- **Spec coverage:** §2 decisions → Tasks 3–4 (roles), 2+4 (active invisibility), 2 (Approach A); §3 modules → Tasks 1–5; §4 atomicity/lock/usage → Task 2 + the Task 3 atomicity test; §5 contract → Tasks 1, 3, 4; §6 errors → Tasks 3–4 (EMBED_FAILED added in Task 3 Step 1); §7 testing/DoD → every task's tests + Tasks 6–7; seeder refactor → Task 5. No spec section unmapped.
- **Type consistency:** `lockMenuRebuild` / `rebuildMenuChunks` / `ensureMenuDocument` / `menuDocContentHash` (Task 2) are the only rebuild exports, used with those exact names in Tasks 3, 4, 5 and the tests; `CreateMenuItem` / `PatchMenuItem` / `priceToDb` (Task 1) used in Tasks 3–4. `rebuildMenuChunks(tx, rid, userId: string | null)` — routes pass `session.user.id`, seeder passes `null`.
- **Known gotchas:** vitest module mocks need `vi.hoisted` + `vi.mock` BEFORE importing the route (Tasks 2–4 do this); Docker Postgres must be up for Tasks 2–6; `usage_events.user_id` is nullable (`set null` FK) so the seeder's `null` is legal; drizzle `numeric` returns strings (`price: "36.00"` in JSON — tests assert the string); Next 16 route ctx params are a Promise (`{ params: Promise.resolve({ id }) }` in tests); the bracket path needs quoting in `git add "src/app/api/menu-items/[id]/route.ts"`; `embed([])` returns `{vectors: [], usageTokens: 0}` without an API call, and with zero cards `rebuildMenuChunks` writes no usage event.
- **Eval scripts** (`eval:seed`/`eval:run`, Task 6) hit real OpenAI and need the funded key; the vitest suite never does.
