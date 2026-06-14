# Phase 5 — Training Modules + Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship module CRUD (ordered, optionally tied to docs/menu items), per-trainee self-marked progress, and a manager roster — and put RLS on `module_progress`, the last unprotected data table.

**Architecture:** Three route files under `/api/modules` (collection, item, progress sub-resource), backed by three focused libs (`validate` input Zod, `refs` tenant ref-resolution, `serialize` output shaping). Every write/read runs in `withTenant(rid, …)` so the `app.restaurant_id` GUC + RLS scope it. Modules are a read/track surface only — **no embeddings, no chunks, no `/api/ask` involvement** (much simpler than Phase 4: no advisory lock, no `502`).

**Tech Stack:** Next.js 16 Route Handlers, Drizzle ORM + `pg`, Zod, PostgreSQL 16 + RLS, vitest (Docker Postgres; OpenAI is NOT involved in this phase).

**Spec:** `docs/superpowers/specs/2026-06-14-phase-5-training-modules-design.md`

**Conventions (apply to every task):**
- Commits follow the repo convention — append the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` to each commit message.
- Implementation happens on a `phase-5-training-modules` branch cut from `main` (per the Phase 4 pattern; the design/plan commits already live on `main`). The execution sub-skill creates it.
- Docker Postgres must be up (`docker compose up -d`); `reg_ai_db` is the test/dev DB. Tests run serially (`vitest.config.ts` `fileParallelism:false`).

---

## File Structure

**Create:**
- `src/lib/modules/validate.ts` — Zod input contracts (`CreateModule`, `PatchModule`, `ProgressUpdate`) + inferred types.
- `src/lib/modules/refs.ts` — `assertRefsResolveInTenant(tx, documentIds?, menuItemIds?)`: every id must resolve in the caller's tenant.
- `src/lib/modules/serialize.ts` — pure output helpers: `normalizeProgress`, `toSummary`, `toDetail`.
- `src/app/api/modules/route.ts` — `POST` (create) · `GET` (list + caller progress).
- `src/app/api/modules/[id]/route.ts` — `GET` (detail) · `PATCH` · `DELETE`.
- `src/app/api/modules/[id]/progress/route.ts` — `PUT` (caller upserts own) · `GET` (manager roster).
- `test/lib/modules-validate.test.ts`, `test/lib/modules-helpers.test.ts`, `test/lib/modules-rls.test.ts`, `test/api/modules.test.ts`.

**Modify:**
- `schema.ts` (root, canonical) — add `modules.position`; tighten `modules.content` type + drop its default; add `module_progress.restaurantId` + index.
- `drizzle/0005_*.sql` — generated, then hand-append the `module_progress` RLS block.
- `docs/api.md` — promote §4 "Module CRUD + progress" from deferred to FINAL.
- `CLAUDE.md` — Phase 5 status.

---

## Task 1: Schema + migration 0005 (module_progress RLS + modules.position)

**Files:**
- Modify: `schema.ts` (root)
- Create: `drizzle/0005_*.sql` (via `db:generate`, then hand-append RLS)
- Test: `test/lib/modules-rls.test.ts`

- [ ] **Step 1: Write the failing RLS test**

Create `test/lib/modules-rls.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { restaurants, users, modules, moduleProgress } from "@/db/schema";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

// Seeds a tenant + trainee + one module + one completed progress row (all under the GUC).
async function seedModuleWithProgress(name: string) {
  const [r] = await db.insert(restaurants).values({ name }).returning();
  track(r.id);
  const [u] = await db.insert(users).values({
    restaurantId: r.id, email: `${crypto.randomUUID()}@t.test`, passwordHash: "x", role: "trainee",
  }).returning();
  return withTenant(r.id, async (tx) => {
    const [m] = await tx.insert(modules).values({
      restaurantId: r.id, title: `${name}-mod`, content: { body: "read me" }, position: 0,
    }).returning();
    const [p] = await tx.insert(moduleProgress).values({
      moduleId: m.id, userId: u.id, restaurantId: r.id, status: "completed",
    }).returning();
    return { restaurant: r, user: u, module: m, progress: p };
  });
}

describe("module_progress RLS + modules.position", () => {
  it("scopes progress reads to the GUC tenant", async () => {
    const a = await seedModuleWithProgress("MPA");
    const b = await seedModuleWithProgress("MPB");
    const aRows = await withTenant(a.restaurant.id, (tx) => tx.select().from(moduleProgress));
    expect(aRows.map((p) => p.id)).toEqual([a.progress.id]);
    const leak = await withTenant(a.restaurant.id, (tx) =>
      tx.select().from(moduleProgress).where(eq(moduleProgress.id, b.progress.id)));
    expect(leak).toHaveLength(0);
  });

  it("WITH CHECK blocks writing progress tagged for a different tenant", async () => {
    const a = await seedModuleWithProgress("MPC");
    const b = await seedModuleWithProgress("MPD");
    await expect(
      withTenant(a.restaurant.id, (tx) =>
        tx.insert(moduleProgress).values({
          moduleId: b.module.id, userId: b.user.id, restaurantId: b.restaurant.id, status: "completed",
        })),
    ).rejects.toThrow();
  });

  it("modules carry an integer position", async () => {
    const a = await seedModuleWithProgress("MPE");
    expect(a.module.position).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- modules-rls`
Expected: FAIL — `column "restaurant_id" of relation "module_progress" does not exist` (and `position` missing).

- [ ] **Step 3: Edit `schema.ts` — `modules` table**

In the `modules` pgTable, replace the `content` line and add `position` (place `position` right after `content`):

```ts
    content: jsonb("content").$type<{ body: string; documentIds?: string[]; menuItemIds?: string[] }>().notNull(),
    position: integer("position").notNull().default(0),
```

(Removes the old `.default([])` — `content` is always supplied by the API; the `[]` default is invalid under the new object type.)

- [ ] **Step 4: Edit `schema.ts` — `module_progress` table**

Add `restaurantId` (after `id`) and a restaurant index (in the table's index array):

```ts
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id").notNull().references(() => restaurants.id, { onDelete: "cascade" }),
```

```ts
  (t) => [
    unique("module_progress_uq").on(t.moduleId, t.userId),
    index("module_progress_user_idx").on(t.userId),
    index("module_progress_restaurant_idx").on(t.restaurantId),
    check("module_progress_score_range", sql`${t.score} IS NULL OR (${t.score} >= 0 AND ${t.score} <= 100)`),
  ],
```

- [ ] **Step 5: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/0005_*.sql` containing (order may vary): `ALTER TABLE "modules" ADD COLUMN "position" integer DEFAULT 0 NOT NULL`, `ALTER TABLE "modules" ALTER COLUMN "content" DROP DEFAULT`, `ALTER TABLE "module_progress" ADD COLUMN "restaurant_id" uuid NOT NULL`, the FK constraint, and `CREATE INDEX "module_progress_restaurant_idx"`.

> Note: the `ADD COLUMN … NOT NULL` (no default) for `restaurant_id` is safe because `module_progress` is empty (new feature) — same situation as migration `0004`. If rows existed, you'd add it nullable, backfill `FROM modules`, then `SET NOT NULL`.

- [ ] **Step 6: Hand-append the RLS block to `drizzle/0005_*.sql`**

Drizzle does not emit RLS policies. Append (matching migration `0004` exactly):

```sql
--> statement-breakpoint
ALTER TABLE "module_progress" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "module_progress" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "module_progress"
  USING      ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);
```

- [ ] **Step 7: Apply the migration**

Run: `npm run db:migrate`
Expected: applies `0005` with no error.

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- modules-rls`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add schema.ts drizzle/ test/lib/modules-rls.test.ts
git commit -m "Phase 5: migration 0005 — module_progress RLS + modules.position (FR-018/FR-019)"
```

---

## Task 2: Module validation (`validate.ts`)

**Files:**
- Create: `src/lib/modules/validate.ts`
- Test: `test/lib/modules-validate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/lib/modules-validate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CreateModule, PatchModule, ProgressUpdate } from "@/lib/modules/validate";

const goodContent = { body: "Lesson text", documentIds: [crypto.randomUUID()], menuItemIds: [crypto.randomUUID()] };

describe("CreateModule", () => {
  it("accepts a minimal valid module (title + content.body)", () => {
    expect(CreateModule.safeParse({ title: "Wine 101", content: { body: "hi" } }).success).toBe(true);
  });
  it("accepts content with tenant ref arrays and an explicit position", () => {
    expect(CreateModule.safeParse({ title: "T", description: null, content: goodContent, position: 3 }).success).toBe(true);
  });
  it("rejects missing title, missing content, empty body, oversize body", () => {
    expect(CreateModule.safeParse({ content: { body: "x" } }).success).toBe(false);
    expect(CreateModule.safeParse({ title: "T" }).success).toBe(false);
    expect(CreateModule.safeParse({ title: "T", content: { body: "" } }).success).toBe(false);
    expect(CreateModule.safeParse({ title: "T", content: { body: "x".repeat(50_001) } }).success).toBe(false);
  });
  it("rejects bad uuids, >50 refs, and unknown keys", () => {
    expect(CreateModule.safeParse({ title: "T", content: { body: "x", documentIds: ["nope"] } }).success).toBe(false);
    expect(CreateModule.safeParse({ title: "T", content: { body: "x", menuItemIds: Array(51).fill(crypto.randomUUID()) } }).success).toBe(false);
    expect(CreateModule.safeParse({ title: "T", content: { body: "x" }, surprise: 1 }).success).toBe(false);
    expect(CreateModule.safeParse({ title: "T", content: { body: "x", extra: 1 } }).success).toBe(false);
  });
});

describe("PatchModule", () => {
  it("accepts a single-field patch and rejects an empty one", () => {
    expect(PatchModule.safeParse({ title: "New" }).success).toBe(true);
    expect(PatchModule.safeParse({ position: 2 }).success).toBe(true);
    expect(PatchModule.safeParse({ description: null }).success).toBe(true);
    expect(PatchModule.safeParse({}).success).toBe(false);
  });
});

describe("ProgressUpdate", () => {
  it("accepts in_progress/completed only", () => {
    expect(ProgressUpdate.safeParse({ status: "in_progress" }).success).toBe(true);
    expect(ProgressUpdate.safeParse({ status: "completed" }).success).toBe(true);
    expect(ProgressUpdate.safeParse({ status: "not_started" }).success).toBe(false);
    expect(ProgressUpdate.safeParse({ status: "done" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- modules-validate`
Expected: FAIL — cannot resolve `@/lib/modules/validate`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/modules/validate.ts`:

```ts
// Request validation for /api/modules (Phase 5 spec §5). One base object; POST and PATCH
// derive from it so field rules can't drift. content is the firmed-up Phase 5 shape:
// authored body + optional tenant-scoped doc/menu references (resolution checked in refs.ts).
import { z } from "zod";

const uuid = z.string().uuid();

export const ModuleContent = z.object({
  body: z.string().trim().min(1).max(50_000),
  documentIds: z.array(uuid).max(50).optional(),
  menuItemIds: z.array(uuid).max(50).optional(),
}).strict();

const base = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable(),
  content: ModuleContent,
  position: z.number().int().min(0),
});

// POST: title + content required; description/position optional (absent => null / append).
export const CreateModule = base.partial().required({ title: true, content: true }).strict();
// PATCH: any subset, at least one key; a content patch replaces the whole object.
export const PatchModule = base.partial().strict()
  .refine((o) => Object.keys(o).length > 0, { message: "At least one field is required" });

// Trainee self-mark — not_started is the implicit default (absent row), so it's not accepted here.
export const ProgressUpdate = z.object({ status: z.enum(["in_progress", "completed"]) }).strict();

export type CreateModuleInput = z.infer<typeof CreateModule>;
export type PatchModuleInput = z.infer<typeof PatchModule>;
export type ModuleContentInput = z.infer<typeof ModuleContent>;
export type ProgressUpdateInput = z.infer<typeof ProgressUpdate>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- modules-validate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/modules/validate.ts test/lib/modules-validate.test.ts
git commit -m "Phase 5: module request validation (shared base, content shape, progress status)"
```

---

## Task 3: Ref-resolution + serialization helpers

**Files:**
- Create: `src/lib/modules/refs.ts`
- Create: `src/lib/modules/serialize.ts`
- Test: `test/lib/modules-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/lib/modules-helpers.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { db, withTenant } from "@/lib/db";
import { restaurants, users, documents, menuItems } from "@/db/schema";
import { assertRefsResolveInTenant } from "@/lib/modules/refs";
import { normalizeProgress, toSummary, toDetail } from "@/lib/modules/serialize";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

async function seedTenant() {
  const [r] = await db.insert(restaurants).values({ name: "RefT" }).returning();
  track(r.id);
  await db.insert(users).values({
    restaurantId: r.id, email: `${crypto.randomUUID()}@t.test`, passwordHash: "x", role: "owner",
  });
  return r;
}

describe("assertRefsResolveInTenant", () => {
  it("true for empty/absent arrays", async () => {
    const r = await seedTenant();
    const ok = await withTenant(r.id, (tx) => assertRefsResolveInTenant(tx, undefined, []));
    expect(ok).toBe(true);
  });
  it("true when ids resolve in tenant, false for a foreign/unknown id", async () => {
    const r = await seedTenant();
    const [doc] = await withTenant(r.id, (tx) => tx.insert(documents).values({
      restaurantId: r.id, title: "SOP", sourceType: "text", contentHash: crypto.randomUUID(), status: "done",
    }).returning());
    const [mi] = await withTenant(r.id, (tx) => tx.insert(menuItems).values({
      restaurantId: r.id, name: "Soup",
    }).returning());
    const ok = await withTenant(r.id, (tx) => assertRefsResolveInTenant(tx, [doc.id], [mi.id]));
    expect(ok).toBe(true);
    const bad = await withTenant(r.id, (tx) => assertRefsResolveInTenant(tx, [crypto.randomUUID()], undefined));
    expect(bad).toBe(false);
  });
});

describe("serialize", () => {
  const row = {
    id: "m1", title: "T", description: null, position: 2,
    content: { body: "B", documentIds: ["d1", "d2"] },
    createdAt: new Date("2026-06-14T00:00:00Z"), updatedAt: new Date("2026-06-14T00:00:00Z"),
    restaurantId: "r1",
  } as never;

  it("normalizeProgress defaults a missing row to not_started", () => {
    expect(normalizeProgress(null)).toEqual({ status: "not_started", startedAt: null, completedAt: null });
    expect(normalizeProgress({ status: "completed", startedAt: new Date("2026-06-14T00:00:00Z"), completedAt: new Date("2026-06-14T00:00:00Z") }))
      .toEqual({ status: "completed", startedAt: "2026-06-14T00:00:00.000Z", completedAt: "2026-06-14T00:00:00.000Z" });
  });
  it("toSummary derives refCounts and omits body; toDetail adds content", () => {
    const s = toSummary(row, normalizeProgress(null));
    expect(s.refCounts).toEqual({ documents: 2, menuItems: 0 });
    expect("content" in s).toBe(false);
    const d = toDetail(row, normalizeProgress(null));
    expect(d.content).toEqual({ body: "B", documentIds: ["d1", "d2"], menuItemIds: [] });
  });
});
```

(Confirmed schema columns: `documents` needs `restaurantId, title, sourceType ∈ {pdf,docx,text}, contentHash, status ∈ {pending..done}`; `menuItems` needs only `restaurantId, name`.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- modules-helpers`
Expected: FAIL — cannot resolve `@/lib/modules/refs` / `@/lib/modules/serialize`.

- [ ] **Step 3: Write `refs.ts`**

Create `src/lib/modules/refs.ts`:

```ts
// Resolve content.documentIds / content.menuItemIds against the caller's own tenant.
// Runs inside withTenant, so the SELECTs are RLS-scoped — a foreign id simply isn't
// returned, and the count mismatch => false => the route returns 400 (no leak).
import { inArray } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { documents, menuItems } from "@/db/schema";

export async function assertRefsResolveInTenant(
  tx: Tx, documentIds?: string[], menuItemIds?: string[],
): Promise<boolean> {
  if (documentIds && documentIds.length) {
    const want = new Set(documentIds);
    const rows = await tx.select({ id: documents.id }).from(documents).where(inArray(documents.id, [...want]));
    if (rows.length !== want.size) return false;
  }
  if (menuItemIds && menuItemIds.length) {
    const want = new Set(menuItemIds);
    const rows = await tx.select({ id: menuItems.id }).from(menuItems).where(inArray(menuItems.id, [...want]));
    if (rows.length !== want.size) return false;
  }
  return true;
}
```

- [ ] **Step 4: Write `serialize.ts`**

Create `src/lib/modules/serialize.ts`:

```ts
// Pure output shaping for /api/modules. ModuleSummary (list) omits the body; Module (detail)
// adds content. Progress is always normalized to a stable shape, never null.
import type { modules, moduleProgress } from "@/db/schema";

type ModuleRow = typeof modules.$inferSelect;
type ProgressRow = typeof moduleProgress.$inferSelect;

export type ProgressView = {
  status: "not_started" | "in_progress" | "completed";
  startedAt: string | null;
  completedAt: string | null;
};

export function normalizeProgress(
  p: Pick<ProgressRow, "status" | "startedAt" | "completedAt"> | null | undefined,
): ProgressView {
  return {
    status: p?.status ?? "not_started",
    startedAt: p?.startedAt ? p.startedAt.toISOString() : null,
    completedAt: p?.completedAt ? p.completedAt.toISOString() : null,
  };
}

export function toSummary(m: ModuleRow, progress: ProgressView) {
  return {
    id: m.id,
    title: m.title,
    description: m.description,
    position: m.position,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    refCounts: {
      documents: m.content.documentIds?.length ?? 0,
      menuItems: m.content.menuItemIds?.length ?? 0,
    },
    progress,
  };
}

export function toDetail(m: ModuleRow, progress: ProgressView) {
  return {
    ...toSummary(m, progress),
    content: {
      body: m.content.body,
      documentIds: m.content.documentIds ?? [],
      menuItemIds: m.content.menuItemIds ?? [],
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- modules-helpers`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/modules/refs.ts src/lib/modules/serialize.ts test/lib/modules-helpers.test.ts
git commit -m "Phase 5: module ref-resolution + serialization helpers"
```

---

## Task 4: Collection routes — `POST` / `GET /api/modules`

**Files:**
- Create: `src/app/api/modules/route.ts`
- Test: `test/api/modules.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/api/modules.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { POST, GET } from "@/app/api/modules/route";
import { registerOwner, makeUserCookie } from "../helpers/auth";
import { cleanup } from "../helpers/db";

afterEach(cleanup);

const post = (cookie: string | null, body: unknown) =>
  POST(new Request("http://x/api/modules", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }));
const list = (cookie: string | null, qs = "") =>
  GET(new Request(`http://x/api/modules${qs}`, { headers: cookie ? { cookie } : {} }));

describe("POST /api/modules", () => {
  it("401 anon; 403 trainee; 201 for manager", async () => {
    expect((await post(null, { title: "T", content: { body: "b" } })).status).toBe(401);
    const { restaurant } = await registerOwner();
    const trainee = await makeUserCookie(restaurant.id, "trainee");
    expect((await post(trainee.cookie, { title: "T", content: { body: "b" } })).status).toBe(403);
    const mgr = await makeUserCookie(restaurant.id, "manager");
    expect((await post(mgr.cookie, { title: "T", content: { body: "b" } })).status).toBe(201);
  });

  it("400 on invalid body and on unknown keys", async () => {
    const { cookie } = await registerOwner();
    expect((await post(cookie, { content: { body: "b" } })).status).toBe(400);
    expect((await post(cookie, { title: "T", content: { body: "b" }, nope: 1 })).status).toBe(400);
  });

  it("400 when a documentId/menuItemId does not resolve in the tenant", async () => {
    const { cookie } = await registerOwner();
    const res = await post(cookie, { title: "T", content: { body: "b", documentIds: [crypto.randomUUID()] } });
    expect(res.status).toBe(400);
  });

  it("appends position and returns detail with not_started progress", async () => {
    const { cookie } = await registerOwner();
    const first = await (await post(cookie, { title: "One", content: { body: "b" } })).json();
    const second = await (await post(cookie, { title: "Two", content: { body: "b" } })).json();
    expect(first.module.position).toBe(0);
    expect(second.module.position).toBe(1);
    expect(first.module.progress).toEqual({ status: "not_started", startedAt: null, completedAt: null });
    expect(first.module.content.body).toBe("b");
  });
});

describe("GET /api/modules", () => {
  it("401 anon; lists own modules in curriculum order; isolates tenants", async () => {
    expect((await list(null)).status).toBe(401);
    const a = await registerOwner();
    const b = await registerOwner();
    await post(a.cookie, { title: "A1", content: { body: "b" }, position: 5 });
    await post(a.cookie, { title: "A0", content: { body: "b" }, position: 1 });
    const bodyB = await (await list(b.cookie)).json();
    expect(bodyB.modules).toHaveLength(0);
    const bodyA = await (await list(a.cookie)).json();
    expect(bodyA.modules.map((m: { title: string }) => m.title)).toEqual(["A0", "A1"]); // position asc
    expect("content" in bodyA.modules[0]).toBe(false);                                   // summary omits body
    expect(bodyA.nextCursor).toBeNull();
  });

  it("400 on a malformed cursor", async () => {
    const { cookie } = await registerOwner();
    expect((await list(cookie, "?cursor=not-valid")).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- test/api/modules`
Expected: FAIL — cannot resolve `@/app/api/modules/route`.

- [ ] **Step 3: Write the implementation**

Create `src/app/api/modules/route.ts`:

```ts
// POST (create) + GET (list) — FR-018. Writes are owner|manager; reads any authenticated
// role (trainees browse the curriculum). List is ordered by (position, id) ascending and
// embeds the caller's own progress per module. Modules never touch embeddings/chunks.
import { NextResponse } from "next/server";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/lib/db";
import { modules, moduleProgress } from "@/db/schema";
import { requireSession, hasRole } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { CreateModule } from "@/lib/modules/validate";
import { assertRefsResolveInTenant } from "@/lib/modules/refs";
import { normalizeProgress, toDetail, toSummary } from "@/lib/modules/serialize";

const PAGE_SIZE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function nextPosition(tx: Tx): Promise<number> {
  const [row] = await tx.select({ max: sql<number | null>`max(${modules.position})` }).from(modules);
  return Number(row?.max ?? -1) + 1;
}

export async function POST(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");

  let body: unknown;
  try { body = await req.json(); }
  catch { return errorResponse("VALIDATION_ERROR", "Expected a JSON body"); }
  const parsed = CreateModule.safeParse(body);
  if (!parsed.success) return errorResponse("VALIDATION_ERROR", "Invalid module", parsed.error.flatten());

  const rid = session.restaurant.id;
  const input = parsed.data;
  const row = await withTenant(rid, async (tx) => {
    if (!await assertRefsResolveInTenant(tx, input.content.documentIds, input.content.menuItemIds)) return null;
    const position = input.position ?? await nextPosition(tx);
    const [created] = await tx.insert(modules).values({
      restaurantId: rid,
      title: input.title,
      description: input.description ?? null,
      content: input.content,
      position,
    }).returning();
    return created;
  });
  if (!row) return errorResponse("VALIDATION_ERROR", "documentIds/menuItemIds must reference items in your restaurant");
  return NextResponse.json({ module: toDetail(row, normalizeProgress(null)) }, { status: 201 });
}

function parseCursor(raw: string | null): { position: number; id: string } | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  const position = Number(raw.slice(0, dot));
  const id = raw.slice(dot + 1);
  if (dot < 0 || !Number.isInteger(position) || position < 0 || !UUID.test(id)) throw new Error("bad cursor");
  return { position, id };
}

export async function GET(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");

  let cursor: { position: number; id: string } | null;
  try { cursor = parseCursor(new URL(req.url).searchParams.get("cursor")); }
  catch { return errorResponse("VALIDATION_ERROR", "Invalid cursor"); }

  const uid = session.user.id;
  const rows = await withTenant(session.restaurant.id, (tx) =>
    tx.select({
      m: modules,
      status: moduleProgress.status,
      startedAt: moduleProgress.startedAt,
      completedAt: moduleProgress.completedAt,
    })
      .from(modules)
      .leftJoin(moduleProgress, and(eq(moduleProgress.moduleId, modules.id), eq(moduleProgress.userId, uid)))
      .where(cursor
        ? or(gt(modules.position, cursor.position), and(eq(modules.position, cursor.position), gt(modules.id, cursor.id)))
        : undefined)
      .orderBy(asc(modules.position), asc(modules.id))
      .limit(PAGE_SIZE + 1));

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const items = page.map((r) =>
    toSummary(r.m, normalizeProgress(r.status ? { status: r.status, startedAt: r.startedAt, completedAt: r.completedAt } : null)));
  const last = page[page.length - 1];
  return NextResponse.json({
    modules: items,
    nextCursor: hasMore && last ? `${last.m.position}.${last.m.id}` : null,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/api/modules`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/modules/route.ts test/api/modules.test.ts
git commit -m "Phase 5: POST/GET /api/modules — create + curriculum-ordered list with caller progress (FR-018)"
```

---

## Task 5: Item routes — `GET` / `PATCH` / `DELETE /api/modules/:id`

**Files:**
- Create: `src/app/api/modules/[id]/route.ts`
- Test: append to `test/api/modules.test.ts`

- [ ] **Step 1: Write the failing test (append)**

Append to `test/api/modules.test.ts`:

```ts
import { GET as GET_ONE, PATCH, DELETE } from "@/app/api/modules/[id]/route";

const getOne = (cookie: string | null, id: string) =>
  GET_ONE(new Request(`http://x/api/modules/${id}`, { headers: cookie ? { cookie } : {} }),
    { params: Promise.resolve({ id }) });
const patch = (cookie: string | null, id: string, body: unknown) =>
  PATCH(new Request(`http://x/api/modules/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
const del = (cookie: string | null, id: string) =>
  DELETE(new Request(`http://x/api/modules/${id}`, { method: "DELETE", headers: cookie ? { cookie } : {} }),
    { params: Promise.resolve({ id }) });

describe("GET /api/modules/:id", () => {
  it("returns detail with the caller's progress; 404 for foreign/missing/non-uuid", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    const created = await (await post(a.cookie, { title: "Read me", content: { body: "deep" } })).json();
    const id = created.module.id;
    const got = await (await getOne(a.cookie, id)).json();
    expect(got.module.content.body).toBe("deep");
    expect(got.module.progress.status).toBe("not_started");
    expect((await getOne(b.cookie, id)).status).toBe(404);
    expect((await getOne(a.cookie, crypto.randomUUID())).status).toBe(404);
    expect((await getOne(a.cookie, "not-a-uuid")).status).toBe(404);
  });
});

describe("PATCH /api/modules/:id", () => {
  it("400 empty patch; 403 trainee; updates fields; reorders via position", async () => {
    const { cookie, restaurant } = await registerOwner();
    const created = await (await post(cookie, { title: "Old", content: { body: "b" }, position: 0 })).json();
    const id = created.module.id;
    expect((await patch(cookie, id, {})).status).toBe(400);
    const trainee = await makeUserCookie(restaurant.id, "trainee");
    expect((await patch(trainee.cookie, id, { title: "X" })).status).toBe(403);
    const updated = await (await patch(cookie, id, { title: "New", description: "d", position: 7 })).json();
    expect(updated.module.title).toBe("New");
    expect(updated.module.description).toBe("d");
    expect(updated.module.position).toBe(7);
    // explicit null clears description
    const cleared = await (await patch(cookie, id, { description: null })).json();
    expect(cleared.module.description).toBeNull();
  });

  it("400 when a content patch references an unresolvable id; 404 foreign", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    const created = await (await post(a.cookie, { title: "T", content: { body: "b" } })).json();
    expect((await patch(a.cookie, created.module.id, { content: { body: "b", menuItemIds: [crypto.randomUUID()] } })).status).toBe(400);
    expect((await patch(b.cookie, created.module.id, { title: "Steal" })).status).toBe(404);
  });
});

describe("DELETE /api/modules/:id", () => {
  it("403 trainee; 204 owner; cascades; foreign 404", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    const created = await (await post(a.cookie, { title: "T", content: { body: "b" } })).json();
    const id = created.module.id;
    const trainee = await makeUserCookie(a.restaurant.id, "trainee");
    expect((await del(trainee.cookie, id)).status).toBe(403);
    expect((await del(b.cookie, id)).status).toBe(404);
    expect((await del(a.cookie, id)).status).toBe(204);
    expect((await getOne(a.cookie, id)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- test/api/modules`
Expected: FAIL — cannot resolve `@/app/api/modules/[id]/route`.

- [ ] **Step 3: Write the implementation**

Create `src/app/api/modules/[id]/route.ts`:

```ts
// GET (detail + caller progress) · PATCH (partial) · DELETE (hard) — FR-018.
// Foreign/missing/non-uuid ids -> 404 (RLS hides foreign rows; anti-enumeration).
// DELETE cascades the module's progress rows via the module_progress FK.
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { withTenant, type Tx } from "@/lib/db";
import { modules, moduleProgress } from "@/db/schema";
import { requireSession, hasRole } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { PatchModule } from "@/lib/modules/validate";
import { assertRefsResolveInTenant } from "@/lib/modules/refs";
import { normalizeProgress, toDetail } from "@/lib/modules/serialize";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function callerProgress(tx: Tx, moduleId: string, userId: string) {
  const [p] = await tx.select({
    status: moduleProgress.status, startedAt: moduleProgress.startedAt, completedAt: moduleProgress.completedAt,
  }).from(moduleProgress)
    .where(and(eq(moduleProgress.moduleId, moduleId), eq(moduleProgress.userId, userId))).limit(1);
  return p ?? null;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  const { id } = await ctx.params;
  if (!UUID.test(id)) return errorResponse("NOT_FOUND", "Module not found");

  const uid = session.user.id;
  const result = await withTenant(session.restaurant.id, async (tx) => {
    const [m] = await tx.select().from(modules).where(eq(modules.id, id)).limit(1);
    if (!m) return null;
    return { m, p: await callerProgress(tx, id, uid) };
  });
  if (!result) return errorResponse("NOT_FOUND", "Module not found");
  return NextResponse.json({ module: toDetail(result.m, normalizeProgress(result.p)) });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");
  const { id } = await ctx.params;
  if (!UUID.test(id)) return errorResponse("NOT_FOUND", "Module not found");

  let body: unknown;
  try { body = await req.json(); }
  catch { return errorResponse("VALIDATION_ERROR", "Expected a JSON body"); }
  const parsed = PatchModule.safeParse(body);
  if (!parsed.success) return errorResponse("VALIDATION_ERROR", "Invalid module patch", parsed.error.flatten());

  const uid = session.user.id;
  const input = parsed.data;
  const outcome = await withTenant(session.restaurant.id, async (tx): Promise<"refs" | "missing" | { m: typeof modules.$inferSelect; p: Awaited<ReturnType<typeof callerProgress>> }> => {
    if (input.content && !await assertRefsResolveInTenant(tx, input.content.documentIds, input.content.menuItemIds)) return "refs";
    const [m] = await tx.update(modules).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
    }).where(eq(modules.id, id)).returning();
    if (!m) return "missing";
    return { m, p: await callerProgress(tx, id, uid) };
  });
  if (outcome === "refs") return errorResponse("VALIDATION_ERROR", "documentIds/menuItemIds must reference items in your restaurant");
  if (outcome === "missing") return errorResponse("NOT_FOUND", "Module not found");
  return NextResponse.json({ module: toDetail(outcome.m, normalizeProgress(outcome.p)) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");
  const { id } = await ctx.params;
  if (!UUID.test(id)) return errorResponse("NOT_FOUND", "Module not found");

  const deleted = await withTenant(session.restaurant.id, async (tx) => {
    const [row] = await tx.delete(modules).where(eq(modules.id, id)).returning({ id: modules.id });
    return row ?? null;
  });
  if (!deleted) return errorResponse("NOT_FOUND", "Module not found");
  return new NextResponse(null, { status: 204 });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/api/modules`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/modules/[id]/route.ts" test/api/modules.test.ts
git commit -m "Phase 5: GET/PATCH/DELETE /api/modules/:id — detail, partial update, hard delete (FR-018)"
```

---

## Task 6: Progress routes — `PUT` / `GET /api/modules/:id/progress`

**Files:**
- Create: `src/app/api/modules/[id]/progress/route.ts`
- Test: append to `test/api/modules.test.ts`

- [ ] **Step 1: Write the failing test (append)**

Append to `test/api/modules.test.ts`:

```ts
import { PUT, GET as ROSTER } from "@/app/api/modules/[id]/progress/route";

const putProgress = (cookie: string | null, id: string, body: unknown) =>
  PUT(new Request(`http://x/api/modules/${id}/progress`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
const roster = (cookie: string | null, id: string) =>
  ROSTER(new Request(`http://x/api/modules/${id}/progress`, { headers: cookie ? { cookie } : {} }),
    { params: Promise.resolve({ id }) });

describe("PUT /api/modules/:id/progress", () => {
  it("trainee marks in_progress then completed; idempotent; re-open clears completedAt", async () => {
    const { cookie, restaurant } = await registerOwner();
    const created = await (await post(cookie, { title: "T", content: { body: "b" } })).json();
    const id = created.module.id;
    const trainee = await makeUserCookie(restaurant.id, "trainee");

    const started = await (await putProgress(trainee.cookie, id, { status: "in_progress" })).json();
    expect(started.progress.status).toBe("in_progress");
    expect(started.progress.startedAt).not.toBeNull();
    expect(started.progress.completedAt).toBeNull();

    const done = await (await putProgress(trainee.cookie, id, { status: "completed" })).json();
    expect(done.progress.status).toBe("completed");
    expect(done.progress.startedAt).toBe(started.progress.startedAt); // startedAt preserved
    expect(done.progress.completedAt).not.toBeNull();

    const reopened = await (await putProgress(trainee.cookie, id, { status: "in_progress" })).json();
    expect(reopened.progress.completedAt).toBeNull();                 // re-open clears completion
  });

  it("400 invalid status; 404 foreign/missing/non-uuid; embedded in own reads only", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    const created = await (await post(a.cookie, { title: "T", content: { body: "b" } })).json();
    const id = created.module.id;
    expect((await putProgress(a.cookie, id, { status: "nope" })).status).toBe(400);
    expect((await putProgress(b.cookie, id, { status: "completed" })).status).toBe(404);   // foreign module
    expect((await putProgress(a.cookie, "not-a-uuid", { status: "completed" })).status).toBe(404);

    // a's own GET reflects a's progress; a second user sees not_started
    await putProgress(a.cookie, id, { status: "completed" });
    const mine = await (await getOne(a.cookie, id)).json();
    expect(mine.module.progress.status).toBe("completed");
    const other = await makeUserCookie(a.restaurant.id, "manager");
    const theirs = await (await getOne(other.cookie, id)).json();
    expect(theirs.module.progress.status).toBe("not_started");
  });
});

describe("GET /api/modules/:id/progress (manager roster)", () => {
  it("403 trainee; lists all trainees incl. not_started; reflects completion; 404 foreign", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    const created = await (await post(a.cookie, { title: "T", content: { body: "b" } })).json();
    const id = created.module.id;
    const t1 = await makeUserCookie(a.restaurant.id, "trainee");
    await makeUserCookie(a.restaurant.id, "trainee"); // t2, never starts
    await putProgress(t1.cookie, id, { status: "completed" });

    expect((await roster(t1.cookie, id)).status).toBe(403);
    expect((await roster(b.cookie, id)).status).toBe(404); // foreign module
    const body = await (await roster(a.cookie, id)).json();
    expect(body.roster).toHaveLength(2);                    // both trainees, owner excluded
    const statuses = body.roster.map((e: { status: string }) => e.status).sort();
    expect(statuses).toEqual(["completed", "not_started"]);
    expect(body.roster.every((e: { user: { email: string } }) => typeof e.user.email === "string")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- test/api/modules`
Expected: FAIL — cannot resolve `@/app/api/modules/[id]/progress/route`.

- [ ] **Step 3: Write the implementation**

Create `src/app/api/modules/[id]/progress/route.ts`:

```ts
// PUT (caller upserts their own progress) + GET (manager roster) — FR-019.
// PUT is any authenticated user (records their own row); GET is owner|manager.
// users has no RLS, so the roster filters restaurant_id explicitly; module_progress is RLS-scoped.
import { NextResponse } from "next/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { modules, moduleProgress, users } from "@/db/schema";
import { requireSession, hasRole } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/http/errors";
import { ProgressUpdate } from "@/lib/modules/validate";
import { normalizeProgress } from "@/lib/modules/serialize";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  const { id } = await ctx.params;
  if (!UUID.test(id)) return errorResponse("NOT_FOUND", "Module not found");

  let body: unknown;
  try { body = await req.json(); }
  catch { return errorResponse("VALIDATION_ERROR", "Expected a JSON body"); }
  const parsed = ProgressUpdate.safeParse(body);
  if (!parsed.success) return errorResponse("VALIDATION_ERROR", "Invalid progress update", parsed.error.flatten());

  const rid = session.restaurant.id;
  const uid = session.user.id;
  const status = parsed.data.status;
  const now = new Date();
  const row = await withTenant(rid, async (tx) => {
    const [mod] = await tx.select({ id: modules.id }).from(modules).where(eq(modules.id, id)).limit(1);
    if (!mod) return null;
    const [p] = await tx.insert(moduleProgress).values({
      moduleId: id, userId: uid, restaurantId: rid, status,
      startedAt: now, completedAt: status === "completed" ? now : null,
    }).onConflictDoUpdate({
      target: [moduleProgress.moduleId, moduleProgress.userId],
      set: {
        status,
        startedAt: sql`coalesce(${moduleProgress.startedAt}, now())`,        // first start wins
        completedAt: status === "completed" ? sql`coalesce(${moduleProgress.completedAt}, now())` : null,
      },
    }).returning();
    return p;
  });
  if (!row) return errorResponse("NOT_FOUND", "Module not found");
  return NextResponse.json({ progress: { moduleId: id, ...normalizeProgress(row) } });
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Sign in required");
  if (!hasRole(session.user.role, "manager")) return errorResponse("FORBIDDEN", "Manager role required");
  const { id } = await ctx.params;
  if (!UUID.test(id)) return errorResponse("NOT_FOUND", "Module not found");

  const rid = session.restaurant.id;
  const rows = await withTenant(rid, async (tx) => {
    const [mod] = await tx.select({ id: modules.id }).from(modules).where(eq(modules.id, id)).limit(1);
    if (!mod) return null;
    return tx.select({
      userId: users.id, email: users.email, role: users.role,
      status: moduleProgress.status, startedAt: moduleProgress.startedAt, completedAt: moduleProgress.completedAt,
    })
      .from(users)
      .leftJoin(moduleProgress, and(eq(moduleProgress.userId, users.id), eq(moduleProgress.moduleId, id)))
      .where(and(eq(users.restaurantId, rid), eq(users.role, "trainee")))
      .orderBy(asc(users.email));
  });
  if (rows === null) return errorResponse("NOT_FOUND", "Module not found");
  return NextResponse.json({
    moduleId: id,
    roster: rows.map((r) => ({
      user: { id: r.userId, email: r.email, role: r.role },
      ...normalizeProgress(r.status ? { status: r.status, startedAt: r.startedAt, completedAt: r.completedAt } : null),
    })),
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/api/modules`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/modules/[id]/progress/route.ts" test/api/modules.test.ts
git commit -m "Phase 5: PUT progress (caller-own upsert) + GET manager roster /api/modules/:id/progress (FR-019)"
```

---

## Task 7: Docs + full verification

**Files:**
- Modify: `docs/api.md` (§4)
- Modify: `CLAUDE.md` (status)

- [ ] **Step 1: Promote `docs/api.md` §4 to FINAL**

Replace the deferred "Module CRUD + progress" row in §4's table with a FINAL section modeled on §3 (Menu). Add before the remaining deferred table:

```markdown
## 4. Modules + progress (`/api/modules`) — Phase 5, FINAL

Ordered training modules a trainee reads and self-marks; managers see a roster. Modules are a
read/track surface — **not** retrieval corpus (no embeddings, no `/api/ask` involvement).

| Route | Roles | Success |
|---|---|---|
| `POST /api/modules` | owner\|manager | `201 {module}` (detail) |
| `GET /api/modules?cursor=&limit=` | any authenticated | `200 {modules, nextCursor}` — `(position,id)` asc, page 20, summaries + caller progress |
| `GET /api/modules/:id` | any authenticated | `200 {module}` (detail: full `content` + caller progress) |
| `PATCH /api/modules/:id` | owner\|manager | `200 {module}` (partial; ≥1 field; explicit `null` clears `description`) |
| `DELETE /api/modules/:id` | owner\|manager | `204` (hard delete; cascades progress) |
| `PUT /api/modules/:id/progress` | any authenticated | `200 {progress}` — upserts the caller's own row |
| `GET /api/modules/:id/progress` | owner\|manager | `200 {moduleId, roster}` — trainee roster (incl. not_started) |

Body (Zod, unknown keys rejected): `title` 1–200 (required POST) · `description` ≤2000, nullable ·
`content` `{body 1–50000, documentIds? uuid[]≤50, menuItemIds? uuid[]≤50}` (required POST; ref ids
must resolve in the caller's tenant else `400`) · `position` int ≥0 (omit ⇒ append). Progress body:
`{status: in_progress|completed}`. Reads normalize absent progress to
`{status:"not_started", startedAt:null, completedAt:null}`.

Errors: standard envelope — `400` validation / unresolvable ref / bad cursor · `401` · `403`
(write or roster below manager) · `404` foreign-tenant/missing/non-uuid (anti-enumeration).
```

Then delete the now-shipped Module row from the deferred table.

- [ ] **Step 2: Update `CLAUDE.md`**

In "Build phases", change the Phase 5 line to `✅ DONE` and mark Phase 6 `◀ CURRENT`. In "Current status", add a `**Phase 5 — COMPLETE.**` block (mirroring the Phase 4 block): note the model (read/self-mark, score reserved), `content` shape + tenant-validated refs, `position` ordering, the 7 routes, **migration 0005 (module_progress RLS — last unprotected table done)**, modules kept out of the RAG/eval path, and the new test count. Move "RLS on module_progress" out of the carried-forward gaps.

- [ ] **Step 3: Full type + test + build verification**

Run each and confirm:
- `npx tsc --noEmit` → clean
- `npm test` → all green (108 prior + the new module tests)
- `npm run build` → green

- [ ] **Step 4: Eval no-regression sanity (not a gate)**

Phase 5 adds no retrieval/AI surface, so the eval set is unaffected. With a funded `OPENAI_API_KEY`:
`npm run eval:seed && npm run eval:run` → all four gates still PASS. (Skip if no key; it is explicitly not a Phase 5 gate.)

- [ ] **Step 5: Commit**

```bash
git add docs/api.md CLAUDE.md
git commit -m "Phase 5 complete: training modules + progress (FR-018/FR-019); module_progress RLS closes the last gap"
```

---

## Self-Review checklist (run before handing off to execution)

- **Spec coverage:** FR-018 → Tasks 4/5 (CRUD, position, refs) ✓ · FR-019 → Tasks 1/6 (progress upsert, roster, RLS) ✓ · FR-020 → deferred (spec §8) ✓ · migration/RLS → Task 1 ✓ · api.md §4 + CLAUDE.md → Task 7 ✓.
- **Anti-enumeration 404** (foreign/missing/non-uuid) covered on every `:id` route (Tasks 5/6).
- **Type consistency:** `assertRefsResolveInTenant(tx, documentIds?, menuItemIds?)`, `normalizeProgress`/`toSummary`/`toDetail`, `CreateModule`/`PatchModule`/`ProgressUpdate`, `nextPosition`, `parseCursor`, `UUID` regex, cursor format `"${position}.${id}"` — names/signatures match across tasks.
- **No placeholders:** every step has concrete code/commands/expected output.

> If executing in a worktree, it should have been created via `superpowers:using-git-worktrees` at execution start.
