# Phase 1: Auth & Multi-Tenancy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship registration, login, logout, and session-based auth with roles, and make every tenant-data access scoped to the caller's restaurant — proven by an isolation test (FR-001–004).

**Architecture:** DB-backed opaque-token sessions (SHA-256 stored). argon2id password hashing. Tenant isolation in depth: tenancy resolved from session (never client input) → app-layer scoping → Postgres RLS backstop on the 6 tenant *data* tables (option Y: single DB role; `users`/`sessions`/`restaurants` stay out of RLS because they're read pre-tenant). A `withTenant()` helper sets a transaction-local `app.restaurant_id` GUC that RLS policies read.

**Tech Stack:** Next.js 16 Route Handlers, Drizzle ORM + `pg`, `@node-rs/argon2`, `zod`, `vitest`, Node `crypto`.

**Spec:** `docs/superpowers/specs/2026-05-29-phase-1-auth-tenancy-design.md`. **Preconditions:** Phase 0 complete; `docker compose up -d db` running before any test task.

---

## File Structure

| File | Responsibility | Author |
|---|---|---|
| `vitest.config.ts` | test runner config (alias `server-only`→stub, tsconfig paths) | scaffold |
| `test/setup.ts` | load `.env` for tests | scaffold |
| `test/stubs/server-only.ts` | empty module so `db.ts` imports under Node | scaffold |
| `test/helpers/db.ts` | create-then-cleanup tenants in tests | scaffold |
| `src/db/schema.ts` | barrel re-export of root `schema.ts` | scaffold |
| `schema.ts` (root) | add `sessions` table | scaffold |
| `drizzle/0001_*.sql` | `sessions` DDL + RLS enable/force/policy on 6 data tables | **David** (policy) |
| `src/lib/db.ts` | add `withTenant()` + `Tx` type; switch to barrel import | **David** (withTenant) |
| `src/lib/http/errors.ts` | error-envelope helper | scaffold |
| `src/lib/auth/password.ts` | `hashPassword` / `verifyPassword` / `verifyDummy` | scaffold |
| `src/lib/auth/session.ts` | token gen+hash, `createSession`/`resolveSession`/`revokeSession`, cookie builders | scaffold |
| `src/lib/auth/types.ts` | Zod request schemas + `PublicUser` mapper | scaffold |
| `src/lib/auth/guard.ts` | `readCookie`, `requireSession`, `hasRole` | scaffold |
| `src/app/api/auth/{register,login,logout,me}/route.ts` | the four handlers | scaffold |

---

## Task 0: Dependencies & test harness

**Files:**
- Modify: `package.json` (deps + scripts)
- Create: `vitest.config.ts`, `test/setup.ts`, `test/stubs/server-only.ts`, `test/smoke.test.ts`

- [ ] **Step 1: Install dependencies**

Run:
```bash
npm install zod @node-rs/argon2
npm install -D vitest vite-tsconfig-paths
```
Expected: added to `package.json`; no errors.

- [ ] **Step 2: Add test scripts to `package.json`**

In `"scripts"`, add (alongside existing):
```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 3: Create the `server-only` stub** — `test/stubs/server-only.ts`

```ts
// Under Node/vitest the real `server-only` package throws on import.
// Tests alias it to this empty module (see vitest.config.ts).
export {};
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // db.ts imports "server-only", which throws outside Next's RSC bundler.
      "server-only": new URL("./test/stubs/server-only.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    // DB tests share one Postgres; run files serially to avoid cross-test races.
    fileParallelism: false,
  },
});
```

- [ ] **Step 5: Create `test/setup.ts`**

```ts
// vitest runs outside Next, so load .env (DATABASE_URL) ourselves before tests import db.ts.
import "dotenv/config";
```

- [ ] **Step 6: Write a smoke test** — `test/smoke.test.ts`

```ts
import { describe, it, expect } from "vitest";

describe("harness", () => {
  it("runs and sees DATABASE_URL", () => {
    expect(process.env.DATABASE_URL).toBeTruthy();
  });
});
```

- [ ] **Step 7: Run it**

Run: `npx vitest run test/smoke.test.ts`
Expected: PASS (1 test).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vitest.config.ts test/
git commit -m "Phase 1: test harness (vitest) + zod/argon2 deps"
```

---

## Task 1: Schema barrel, `sessions` table, migration 0001 (with RLS)

**Files:**
- Create: `src/db/schema.ts`
- Modify: `src/lib/db.ts` (import path only), `schema.ts` (add table)
- Create: `drizzle/0001_*.sql` (generated, then hand-edited)

- [ ] **Step 1: Create the schema barrel** — `src/db/schema.ts`

```ts
// Single import surface for app code. Root schema.ts stays canonical (drizzle.config
// points at it); this lets modules write `@/db/schema` instead of `../../../schema`.
export * from "../../schema";
```

- [ ] **Step 2: Point `db.ts` at the barrel**

In `src/lib/db.ts`, change the schema import:
```ts
import * as schema from "@/db/schema";
```
(replacing `import * as schema from "../../schema";`)

- [ ] **Step 3: Add the `sessions` table to root `schema.ts`**

Add after the `users` table definition:
```ts
// ---- sessions — FR-002 ------------------------------------------------------
// Opaque-token server-side sessions. id = SHA-256(token) hex (NOT the raw token),
// so a DB leak can't be replayed as live sessions. No restaurant_id, no RLS:
// resolved BEFORE the tenant GUC is set (the login bootstrap).
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`
Expected: `[✓] Your SQL migration file ➜ drizzle/0001_<name>.sql` containing `CREATE TABLE "sessions"`.

- [ ] **Step 5: Hand-add the RLS block to the new `drizzle/0001_<name>.sql`**

Append these statements (David writes/owns this policy). Repeat the three-line pattern for each of the 6 data tables — `documents`, `chunks`, `menu_items`, `modules`, `conversations`, `usage_events`:
```sql
--> statement-breakpoint
-- Phase 1 tenant-isolation backstop (option Y). FORCE so the owning role obeys too.
-- current_setting(..., true): unset GUC -> NULL -> no rows (forgotten scope fails safe to empty).
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "documents"
  USING ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chunks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "chunks"
  USING ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "menu_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "menu_items"
  USING ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "modules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "modules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "modules"
  USING ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversations"
  USING ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "usage_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "usage_events"
  USING ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK ("restaurant_id" = current_setting('app.restaurant_id', true)::uuid);
```

- [ ] **Step 6: Apply the migration**

Run: `npm run db:migrate`
Expected: `migrations applied successfully!`

- [ ] **Step 7: Verify tables + policies in the DB**

Run:
```bash
docker compose exec -T db psql -U reg -d reg_ai -v ON_ERROR_STOP=1 \
  -c "SELECT 1 FROM information_schema.tables WHERE table_name='sessions';" \
  -c "SELECT tablename FROM pg_policies WHERE policyname='tenant_isolation' ORDER BY tablename;"
```
Expected: `sessions` exists; 6 rows: chunks, conversations, documents, menu_items, modules, usage_events.

- [ ] **Step 8: Typecheck + commit**

Run: `npx tsc --noEmit`  → Expected: clean.
```bash
git add schema.ts src/db/schema.ts src/lib/db.ts drizzle/
git commit -m "Phase 1: sessions table + RLS on the 6 tenant data tables (migration 0001)"
```

---

## Task 2: `withTenant` + RLS isolation backstop (the FR-004 DB proof)

**Files:**
- Modify: `src/lib/db.ts`
- Create: `test/helpers/db.ts`, `test/lib/db.withTenant.test.ts`

- [ ] **Step 1: Write the test helper** — `test/helpers/db.ts`

```ts
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { restaurants } from "@/db/schema";

const created: string[] = [];

export function track(restaurantId: string): void {
  created.push(restaurantId);
}

// Deleting restaurants (no RLS) cascades to users/sessions/documents/chunks.
// FK cascade bypasses RLS, so this works without setting the GUC.
export async function cleanup(): Promise<void> {
  const ids = created.splice(0);
  if (ids.length) await db.delete(restaurants).where(inArray(restaurants.id, ids));
}
```

- [ ] **Step 2: Write the failing isolation test** — `test/lib/db.withTenant.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { restaurants, documents } from "@/db/schema";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

async function seedRestaurantWithDoc(name: string) {
  const [r] = await db.insert(restaurants).values({ name }).returning();
  track(r.id);
  // documents has RLS+FORCE: inserting requires the GUC set (exercises WITH CHECK).
  const rows = await withTenant(r.id, (tx) =>
    tx.insert(documents).values({
      restaurantId: r.id, title: `${name} doc`, sourceType: "text", contentHash: `${name}-hash`,
    }).returning(),
  );
  return { restaurant: r, doc: rows[0] };
}

describe("withTenant + RLS", () => {
  it("scopes reads to the GUC tenant and hides other tenants' rows", async () => {
    const a = await seedRestaurantWithDoc("AAA");
    const b = await seedRestaurantWithDoc("BBB");

    const aDocs = await withTenant(a.restaurant.id, (tx) => tx.select().from(documents));
    expect(aDocs.map((d) => d.id)).toEqual([a.doc.id]); // only A's

    // B's doc id is invisible under A's GUC (RLS backstop, not app logic).
    const leak = await withTenant(a.restaurant.id, (tx) =>
      tx.select().from(documents).where(eq(documents.id, b.doc.id)),
    );
    expect(leak).toHaveLength(0);
  });

  it("WITH CHECK blocks inserting a row for a different (real) tenant", async () => {
    const a = await seedRestaurantWithDoc("CCC");
    const b = await seedRestaurantWithDoc("DDD"); // a real restaurant, so the FK passes
    // Under A's GUC, inserting a row tagged for B fails the policy's WITH CHECK (not the FK).
    await expect(
      withTenant(a.restaurant.id, (tx) =>
        tx.insert(documents).values({
          restaurantId: b.restaurant.id, title: "evil", sourceType: "text", contentHash: "evil-hash",
        }),
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run it — verify it fails**

Run: `npx vitest run test/lib/db.withTenant.test.ts`
Expected: FAIL — `withTenant is not a function` / not exported.

- [ ] **Step 4: Implement `withTenant` in `src/lib/db.ts`**

Add the `sql` import and append:
```ts
import { sql } from "drizzle-orm";

// The drizzle transaction handle type (what withTenant hands its callback).
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Run `fn` inside a transaction with app.restaurant_id set for RLS.
// `true` = transaction-local: auto-clears on commit/rollback, so the GUC can NEVER
// leak into the next request that reuses this pooled connection. This is the single
// most important correctness detail of Phase 1.
export function withTenant<T>(restaurantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.restaurant_id', ${restaurantId}, true)`);
    return fn(tx);
  });
}
```

- [ ] **Step 5: Run it — verify it passes**

Run: `npx vitest run test/lib/db.withTenant.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/db.ts test/
git commit -m "Phase 1: withTenant GUC helper + RLS isolation test (FR-004 backstop)"
```

---

## Task 3: Error envelope helper

**Files:**
- Create: `src/lib/http/errors.ts`, `test/lib/errors.test.ts`

- [ ] **Step 1: Write the failing test** — `test/lib/errors.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { errorResponse } from "@/lib/http/errors";

describe("errorResponse", () => {
  it("maps codes to statuses and wraps the envelope", async () => {
    const res = errorResponse("FORBIDDEN", "nope");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "FORBIDDEN", message: "nope" } });
  });

  it("includes details when provided", async () => {
    const res = errorResponse("VALIDATION_ERROR", "bad", { field: "email" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "VALIDATION_ERROR", message: "bad", details: { field: "email" } },
    });
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run test/lib/errors.test.ts`
Expected: FAIL — cannot find module `@/lib/http/errors`.

- [ ] **Step 3: Implement** — `src/lib/http/errors.ts`

```ts
import { NextResponse } from "next/server";

export type ErrorCode =
  | "VALIDATION_ERROR" | "UNAUTHENTICATED" | "FORBIDDEN"
  | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403,
  NOT_FOUND: 404, CONFLICT: 409, RATE_LIMITED: 429, INTERNAL: 500,
};

export function errorResponse(code: ErrorCode, message: string, details?: unknown): NextResponse {
  const body = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status: STATUS[code] });
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run test/lib/errors.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/http/ test/lib/errors.test.ts
git commit -m "Phase 1: error-envelope helper"
```

---

## Task 4: Password hashing (argon2id)

**Files:**
- Create: `src/lib/auth/password.ts`, `test/lib/password.test.ts`

- [ ] **Step 1: Write the failing test** — `test/lib/password.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, verifyDummy } from "@/lib/auth/password";

describe("password", () => {
  it("hashes (not plaintext) and verifies round-trip", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h).not.toBe("correct horse battery staple");
    expect(await verifyPassword(h, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(h, "wrong")).toBe(false);
  });

  it("verifyPassword returns false on a malformed hash instead of throwing", async () => {
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });

  it("verifyDummy resolves without throwing (timing equalizer)", async () => {
    await expect(verifyDummy("anything")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run test/lib/password.test.ts`
Expected: FAIL — cannot find module `@/lib/auth/password`.

- [ ] **Step 3: Implement** — `src/lib/auth/password.ts`

```ts
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

export function hashPassword(plain: string): Promise<string> {
  return argonHash(plain); // argon2id with library defaults
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hash, plain);
  } catch {
    return false; // malformed/garbage hash is simply "not valid"
  }
}

// Verify against a throwaway hash so login timing doesn't reveal whether an email
// exists (anti-enumeration). Always resolves; result is intentionally discarded.
let dummyHash: Promise<string> | undefined;
export async function verifyDummy(plain: string): Promise<void> {
  dummyHash ??= argonHash("timing-equalizer-not-a-real-password");
  try {
    await argonVerify(await dummyHash, plain);
  } catch {
    /* ignore */
  }
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run test/lib/password.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/password.ts test/lib/password.test.ts
git commit -m "Phase 1: argon2id password hashing"
```

---

## Task 5: Auth types (Zod schemas + PublicUser mapper)

**Files:**
- Create: `src/lib/auth/types.ts`, `test/lib/types.test.ts`

- [ ] **Step 1: Write the failing test** — `test/lib/types.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { RegisterReq, LoginReq, toPublicUser } from "@/lib/auth/types";

describe("auth types", () => {
  it("RegisterReq rejects short passwords and bad emails", () => {
    expect(RegisterReq.safeParse({ restaurantName: "R", email: "a@b.co", password: "short" }).success).toBe(false);
    expect(RegisterReq.safeParse({ restaurantName: "R", email: "nope", password: "x".repeat(12) }).success).toBe(false);
    expect(RegisterReq.safeParse({ restaurantName: "R", email: "a@b.co", password: "x".repeat(12) }).success).toBe(true);
  });

  it("LoginReq requires an email", () => {
    expect(LoginReq.safeParse({ email: "nope", password: "x" }).success).toBe(false);
  });

  it("toPublicUser strips passwordHash", () => {
    const row = {
      id: "u1", restaurantId: "r1", email: "a@b.co", passwordHash: "secret",
      role: "owner" as const, createdAt: new Date(), updatedAt: new Date(),
    };
    const pub = toPublicUser(row);
    expect("passwordHash" in pub).toBe(false);
    expect(pub.email).toBe("a@b.co");
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run test/lib/types.test.ts`
Expected: FAIL — cannot find module `@/lib/auth/types`.

- [ ] **Step 3: Implement** — `src/lib/auth/types.ts`

```ts
import { z } from "zod";
import type { InferSelectModel } from "drizzle-orm";
import type { users, restaurants } from "@/db/schema";

export const RegisterReq = z.object({
  restaurantName: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(12),
});
export const LoginReq = z.object({
  email: z.string().email(),
  password: z.string(),
});

export type UserRow = InferSelectModel<typeof users>;
export type Restaurant = InferSelectModel<typeof restaurants>;
export type PublicUser = Omit<UserRow, "passwordHash">;

export function toPublicUser(u: UserRow): PublicUser {
  const { passwordHash: _omit, ...pub } = u;
  return pub;
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run test/lib/types.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/types.ts test/lib/types.test.ts
git commit -m "Phase 1: auth Zod schemas + PublicUser mapper"
```

---

## Task 6: Session module

**Files:**
- Create: `src/lib/auth/session.ts`, `test/lib/session.test.ts`

- [ ] **Step 1: Write the failing test** — `test/lib/session.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { restaurants, users, sessions } from "@/db/schema";
import { createSession, resolveSession, revokeSession, hashToken } from "@/lib/auth/session";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

async function makeUser() {
  const [r] = await db.insert(restaurants).values({ name: "S" }).returning();
  track(r.id);
  const [u] = await db.insert(users).values({
    restaurantId: r.id, email: `${crypto.randomUUID()}@t.test`, passwordHash: "x", role: "owner",
  }).returning();
  return u;
}

describe("session", () => {
  it("create -> resolve round-trips and stores the hash, not the token", async () => {
    const u = await makeUser();
    const { token } = await createSession(u.id);
    const stored = await db.select().from(sessions).where(eq(sessions.id, hashToken(token)));
    expect(stored).toHaveLength(1);                 // looked up by hash
    expect(stored[0].id).not.toBe(token);           // raw token not stored
    const resolved = await resolveSession(token);
    expect(resolved?.user.id).toBe(u.id);
    expect(resolved?.restaurant.id).toBe(u.restaurantId);
  });

  it("resolve returns null for an expired session and deletes it", async () => {
    const u = await makeUser();
    const { token } = await createSession(u.id);
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, hashToken(token)));
    expect(await resolveSession(token)).toBeNull();
    expect(await db.select().from(sessions).where(eq(sessions.id, hashToken(token)))).toHaveLength(0);
  });

  it("revoke removes the session", async () => {
    const u = await makeUser();
    const { token } = await createSession(u.id);
    await revokeSession(token);
    expect(await resolveSession(token)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run test/lib/session.test.ts`
Expected: FAIL — cannot find module `@/lib/auth/session`.

- [ ] **Step 3: Implement** — `src/lib/auth/session.ts`

```ts
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { sessions, users, restaurants } from "@/db/schema";
import type { Restaurant, UserRow } from "@/lib/auth/types";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, no sliding renewal
export const SESSION_COOKIE = "sid";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

export type ResolvedSession = { user: UserRow; restaurant: Restaurant };

export async function resolveSession(token: string): Promise<ResolvedSession | null> {
  const id = hashToken(token);
  const rows = await db
    .select({ session: sessions, user: users, restaurant: restaurants })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(restaurants, eq(restaurants.id, users.restaurantId))
    .where(eq(sessions.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.session.expiresAt.getTime() <= Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  return { user: row.user, restaurant: row.restaurant };
}

export async function revokeSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

type CookieSpec = {
  name: string; value: string; httpOnly: true; sameSite: "strict";
  secure: true; path: "/"; expires?: Date; maxAge?: number;
};

export function buildSessionCookie(token: string, expiresAt: Date): CookieSpec {
  return { name: SESSION_COOKIE, value: token, httpOnly: true, sameSite: "strict", secure: true, path: "/", expires: expiresAt };
}

export function clearSessionCookie(): CookieSpec {
  return { name: SESSION_COOKIE, value: "", httpOnly: true, sameSite: "strict", secure: true, path: "/", maxAge: 0 };
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run test/lib/session.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/session.ts test/lib/session.test.ts
git commit -m "Phase 1: DB-backed session module (create/resolve/revoke + cookies)"
```

---

## Task 7: Guard (cookie read, requireSession, hasRole)

**Files:**
- Create: `src/lib/auth/guard.ts`, `test/lib/guard.test.ts`

- [ ] **Step 1: Write the failing test** — `test/lib/guard.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { restaurants, users } from "@/db/schema";
import { createSession } from "@/lib/auth/session";
import { readCookie, requireSession, hasRole } from "@/lib/auth/guard";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

describe("guard", () => {
  it("readCookie parses the named cookie", () => {
    const req = new Request("http://x/", { headers: { cookie: "a=1; sid=tok123; b=2" } });
    expect(readCookie(req, "sid")).toBe("tok123");
    expect(readCookie(new Request("http://x/"), "sid")).toBeNull();
  });

  it("hasRole respects the rank owner>=manager>=trainee", () => {
    expect(hasRole("owner", "manager")).toBe(true);
    expect(hasRole("trainee", "manager")).toBe(false);
    expect(hasRole("manager", "manager")).toBe(true);
  });

  it("requireSession returns the session for a valid sid cookie, null otherwise", async () => {
    const [r] = await db.insert(restaurants).values({ name: "G" }).returning();
    track(r.id);
    const [u] = await db.insert(users).values({
      restaurantId: r.id, email: `${crypto.randomUUID()}@t.test`, passwordHash: "x", role: "manager",
    }).returning();
    const { token } = await createSession(u.id);

    const ok = await requireSession(new Request("http://x/", { headers: { cookie: `sid=${token}` } }));
    expect(ok?.user.id).toBe(u.id);
    expect(await requireSession(new Request("http://x/"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run test/lib/guard.test.ts`
Expected: FAIL — cannot find module `@/lib/auth/guard`.

- [ ] **Step 3: Implement** — `src/lib/auth/guard.ts`

```ts
import { resolveSession, type ResolvedSession, SESSION_COOKIE } from "@/lib/auth/session";

const ROLE_RANK = { trainee: 1, manager: 2, owner: 3 } as const;
export type Role = keyof typeof ROLE_RANK;

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function requireSession(req: Request): Promise<ResolvedSession | null> {
  const token = readCookie(req, SESSION_COOKIE);
  return token ? resolveSession(token) : Promise.resolve(null);
}

export function hasRole(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run test/lib/guard.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/guard.ts test/lib/guard.test.ts
git commit -m "Phase 1: auth guard (requireSession + role rank)"
```

---

## Task 8: Register route

**Files:**
- Create: `src/app/api/auth/register/route.ts`, `test/api/register.test.ts`

- [ ] **Step 1: Write the failing test** — `test/api/register.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/auth/register/route";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

function req(body: unknown) {
  return new Request("http://x/api/auth/register", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("POST /api/auth/register", () => {
  it("creates a restaurant + owner, sets a session cookie, returns 201", async () => {
    const email = `${crypto.randomUUID()}@t.test`;
    const res = await POST(req({ restaurantName: "Le Test", email, password: "x".repeat(12) }));
    expect(res.status).toBe(201);
    const json = await res.json();
    track(json.restaurant.id);
    expect(json.user.role).toBe("owner");
    expect(json.user.email).toBe(email);
    expect("passwordHash" in json.user).toBe(false);
    expect(res.cookies.get("sid")?.value).toBeTruthy();
  });

  it("rejects a duplicate email with 409", async () => {
    const email = `${crypto.randomUUID()}@t.test`;
    const first = await POST(req({ restaurantName: "A", email, password: "x".repeat(12) }));
    track((await first.json()).restaurant.id);
    const dup = await POST(req({ restaurantName: "B", email, password: "y".repeat(12) }));
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.code).toBe("CONFLICT");
  });

  it("rejects a bad body with 400", async () => {
    const res = await POST(req({ restaurantName: "", email: "nope", password: "short" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run test/api/register.test.ts`
Expected: FAIL — cannot find module `@/app/api/auth/register/route`.

- [ ] **Step 3: Implement** — `src/app/api/auth/register/route.ts`

```ts
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { restaurants, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { createSession, buildSessionCookie } from "@/lib/auth/session";
import { RegisterReq, toPublicUser } from "@/lib/auth/types";
import { errorResponse } from "@/lib/http/errors";

export async function POST(req: Request) {
  const parsed = RegisterReq.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("VALIDATION_ERROR", "Invalid registration", parsed.error.flatten());
  }
  const email = parsed.data.email.trim().toLowerCase();

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length) return errorResponse("CONFLICT", "Email already registered");

  const passwordHash = await hashPassword(parsed.data.password);

  const { user, restaurant } = await db.transaction(async (tx) => {
    const [restaurant] = await tx.insert(restaurants).values({ name: parsed.data.restaurantName }).returning();
    const [user] = await tx.insert(users)
      .values({ restaurantId: restaurant.id, email, passwordHash, role: "owner" }).returning();
    return { user, restaurant };
  });

  const { token, expiresAt } = await createSession(user.id);
  const res = NextResponse.json({ user: toPublicUser(user), restaurant }, { status: 201 });
  res.cookies.set(buildSessionCookie(token, expiresAt));
  return res;
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run test/api/register.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/register/ test/api/register.test.ts
git commit -m "Phase 1: POST /api/auth/register (FR-001/002)"
```

---

## Task 9: Login route

**Files:**
- Create: `src/app/api/auth/login/route.ts`, `test/api/login.test.ts`

- [ ] **Step 1: Write the failing test** — `test/api/login.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as login } from "@/app/api/auth/login/route";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

let email: string;
const password = "x".repeat(12);

beforeEach(async () => {
  email = `${crypto.randomUUID()}@t.test`;
  const res = await register(new Request("http://x/", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ restaurantName: "L", email, password }),
  }));
  track((await res.json()).restaurant.id);
});

function loginReq(body: unknown) {
  return new Request("http://x/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("POST /api/auth/login", () => {
  it("logs in with correct credentials, sets cookie, 200", async () => {
    const res = await login(loginReq({ email, password }));
    expect(res.status).toBe(200);
    expect(res.cookies.get("sid")?.value).toBeTruthy();
    expect((await res.json()).user.email).toBe(email);
  });

  it("rejects wrong password with 401", async () => {
    const res = await login(loginReq({ email, password: "wrong-password" }));
    expect(res.status).toBe(401);
  });

  it("rejects unknown email with 401 and the same message (no enumeration)", async () => {
    const res = await login(loginReq({ email: `${crypto.randomUUID()}@t.test`, password }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toBe("Invalid email or password");
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run test/api/login.test.ts`
Expected: FAIL — cannot find module `@/app/api/auth/login/route`.

- [ ] **Step 3: Implement** — `src/app/api/auth/login/route.ts`

```ts
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, restaurants } from "@/db/schema";
import { verifyPassword, verifyDummy } from "@/lib/auth/password";
import { createSession, buildSessionCookie } from "@/lib/auth/session";
import { LoginReq, toPublicUser } from "@/lib/auth/types";
import { errorResponse } from "@/lib/http/errors";

export async function POST(req: Request) {
  const parsed = LoginReq.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("VALIDATION_ERROR", "Invalid login", parsed.error.flatten());
  }
  const email = parsed.data.email.trim().toLowerCase();

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    await verifyDummy(parsed.data.password); // equalize timing — no user enumeration
    return errorResponse("UNAUTHENTICATED", "Invalid email or password");
  }
  if (!(await verifyPassword(user.passwordHash, parsed.data.password))) {
    return errorResponse("UNAUTHENTICATED", "Invalid email or password");
  }

  const [restaurant] = await db.select().from(restaurants).where(eq(restaurants.id, user.restaurantId)).limit(1);
  const { token, expiresAt } = await createSession(user.id);
  const res = NextResponse.json({ user: toPublicUser(user), restaurant }, { status: 200 });
  res.cookies.set(buildSessionCookie(token, expiresAt));
  return res;
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run test/api/login.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/login/ test/api/login.test.ts
git commit -m "Phase 1: POST /api/auth/login (FR-002, anti-enumeration)"
```

---

## Task 10: Logout route

**Files:**
- Create: `src/app/api/auth/logout/route.ts`, `test/api/logout.test.ts`

- [ ] **Step 1: Write the failing test** — `test/api/logout.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { resolveSession } from "@/lib/auth/session";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

describe("POST /api/auth/logout", () => {
  it("revokes the session and clears the cookie (204)", async () => {
    const reg = await register(new Request("http://x/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ restaurantName: "LO", email: `${crypto.randomUUID()}@t.test`, password: "x".repeat(12) }),
    }));
    track((await reg.json()).restaurant.id);
    const token = reg.cookies.get("sid")!.value;

    const res = await logout(new Request("http://x/api/auth/logout", { method: "POST", headers: { cookie: `sid=${token}` } }));
    expect(res.status).toBe(204);
    expect(res.cookies.get("sid")?.value).toBe("");      // cleared
    expect(await resolveSession(token)).toBeNull();        // revoked in DB
  });

  it("is idempotent with no cookie (204)", async () => {
    const res = await logout(new Request("http://x/api/auth/logout", { method: "POST" }));
    expect(res.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run test/api/logout.test.ts`
Expected: FAIL — cannot find module `@/app/api/auth/logout/route`.

- [ ] **Step 3: Implement** — `src/app/api/auth/logout/route.ts`

```ts
import { NextResponse } from "next/server";
import { readCookie } from "@/lib/auth/guard";
import { revokeSession, clearSessionCookie, SESSION_COOKIE } from "@/lib/auth/session";

export async function POST(req: Request) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await revokeSession(token);
  const res = new NextResponse(null, { status: 204 });
  res.cookies.set(clearSessionCookie());
  return res;
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run test/api/logout.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/logout/ test/api/logout.test.ts
git commit -m "Phase 1: POST /api/auth/logout"
```

---

## Task 11: Me route

**Files:**
- Create: `src/app/api/auth/me/route.ts`, `test/api/me.test.ts`

- [ ] **Step 1: Write the failing test** — `test/api/me.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest";
import { POST as register } from "@/app/api/auth/register/route";
import { GET as me } from "@/app/api/auth/me/route";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

describe("GET /api/auth/me", () => {
  it("returns the session user + restaurant (no passwordHash)", async () => {
    const email = `${crypto.randomUUID()}@t.test`;
    const reg = await register(new Request("http://x/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ restaurantName: "ME", email, password: "x".repeat(12) }),
    }));
    track((await reg.json()).restaurant.id);
    const token = reg.cookies.get("sid")!.value;

    const res = await me(new Request("http://x/api/auth/me", { headers: { cookie: `sid=${token}` } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.email).toBe(email);
    expect("passwordHash" in json.user).toBe(false);
    expect(json.restaurant.name).toBe("ME");
  });

  it("returns 401 without a session", async () => {
    const res = await me(new Request("http://x/api/auth/me"));
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run test/api/me.test.ts`
Expected: FAIL — cannot find module `@/app/api/auth/me/route`.

- [ ] **Step 3: Implement** — `src/app/api/auth/me/route.ts`

```ts
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { toPublicUser } from "@/lib/auth/types";
import { errorResponse } from "@/lib/http/errors";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await requireSession(req);
  if (!session) return errorResponse("UNAUTHENTICATED", "Not signed in");
  return NextResponse.json({ user: toPublicUser(session.user), restaurant: session.restaurant });
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run test/api/me.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/me/ test/api/me.test.ts
git commit -m "Phase 1: GET /api/auth/me"
```

---

## Task 12: Full-lifecycle integration + final verification

**Files:**
- Create: `test/api/lifecycle.test.ts`
- Modify: `CLAUDE.md` (status)

- [ ] **Step 1: Write the lifecycle integration test** — `test/api/lifecycle.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as me } from "@/app/api/auth/me/route";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

const J = { "content-type": "application/json" };

describe("auth lifecycle", () => {
  it("register -> me -> logout -> me(401), and login again", async () => {
    const email = `${crypto.randomUUID()}@t.test`;
    const password = "x".repeat(12);

    const reg = await register(new Request("http://x/", { method: "POST", headers: J, body: JSON.stringify({ restaurantName: "Cycle", email, password }) }));
    track((await reg.json()).restaurant.id);
    const sid = reg.cookies.get("sid")!.value;

    expect((await me(new Request("http://x/", { headers: { cookie: `sid=${sid}` } }))).status).toBe(200);

    const out = await logout(new Request("http://x/", { method: "POST", headers: { cookie: `sid=${sid}` } }));
    expect(out.status).toBe(204);

    expect((await me(new Request("http://x/", { headers: { cookie: `sid=${sid}` } }))).status).toBe(401);

    const back = await login(new Request("http://x/", { method: "POST", headers: J, body: JSON.stringify({ email, password }) }));
    expect(back.status).toBe(200);
    expect(back.cookies.get("sid")?.value).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the FULL suite**

Run: `npm run test`
Expected: ALL tests PASS across every `test/**` file.

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: tsc clean; build green (4 auth routes appear under Route (app)).

- [ ] **Step 4: Update `CLAUDE.md` status**

In the "Current status" section, mark Phase 1 complete and set the next step to Phase 2 (Document Ingestion, FR-005–009). Note that the role guard's first real consumer is Phase 2's `owner|manager` upload route, and that `messages`/`message_sources`/`module_progress` still need RLS in their phases.

- [ ] **Step 5: Final commit**

```bash
git add test/api/lifecycle.test.ts CLAUDE.md
git commit -m "Phase 1 complete: auth lifecycle integration + status update (FR-001-004)"
```

---

## Definition of Done

- `npm run test` green (unit + integration + the RLS isolation test).
- `npx tsc --noEmit` clean; `npm run build` green.
- Migration `0001` applies from scratch; `sessions` exists; `tenant_isolation` policy on all 6 data tables.
- Manual: `register` → `me` → `logout` → `me`(401) works; cross-tenant document read is empty under RLS.
- David can explain `withTenant`'s transaction-local GUC and the fail-safe policy.

## Known gaps (deliberate, per spec §9)
- Login rate-limiting → Phase 7 (FR-026).
- RLS on `messages`/`message_sources`/`module_progress` → their building phases.
- Role-guard *enforcement on a protected route* is demonstrated in Phase 2 (first `owner|manager` endpoint); Phase 1 proves the guard mechanism by unit test.
