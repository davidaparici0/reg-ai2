# Phase 1 Design — Auth & Multi-Tenancy

**Status:** approved design (brainstorming output), ready to turn into an implementation plan.
**Phase:** 1. **FRs:** FR-001–004. **Depends on:** Phase 0 (DB layer, `db.ts`, migrations).
**Date:** 2026-05-29.

This spec is the *what* and *why* for Phase 1. It refines — does not replace — the locked
contracts in `docs/api.md §2.1` (auth endpoints) and `docs/architecture.md §3–4` (defense in
depth + D1 RLS). Where this spec and those docs agree, those docs remain canonical.

---

## 1. Goal & FR map

A restaurant can be created with its first owner; users log in with hashed passwords and get a
session; routes enforce roles; and **every** data access is scoped to the caller's restaurant —
proven by an isolation test, not assumed.

| FR | Requirement | Delivered by |
|---|---|---|
| FR-001 | Create a restaurant (tenant) | `POST /api/auth/register` creates `restaurants` + first `users` row (role `owner`) in one transaction |
| FR-002 | Users + login with hashed passwords | argon2id hashing; successful login issues a DB-backed session cookie |
| FR-003 | Roles owner/manager/trainee | `users.role`; `requireRole(min)` guard rejects below the route's minimum |
| FR-004 | Tenant-scoped access on every request, tested | App-layer scoping + Postgres RLS backstop + an isolation test (§8) that is the deliverable |

---

## 2. Decisions locked in brainstorming

1. **Sessions = DB-backed table** (opaque token), not a stateless sealed cookie. Reason: instant
   server-side revocation, trivially auditable, easy to reason about and defend.
2. **Password hashing = argon2id** via `@node-rs/argon2` (prebuilt binaries — no native compile in
   the Docker build). OWASP's first-choice, memory-hard, no 72-byte input cap.
3. **RLS scope = Option Y:** RLS on the **6 tenant *data* tables** only, with a **single DB role**.
   `users` / `sessions` / `restaurants` are deliberately NOT under RLS because they are read
   *before* a tenant is known (the login bootstrap). See §5 for the full reasoning — this is the
   load-bearing decision of the phase.

---

## 3. Schema delta — exactly one new table

No changes to `restaurants` or `users`. One table added:

```ts
// sessions — FR-002. Opaque-token, server-side sessions.
// id = SHA-256 of the random token (hex), NOT the token itself: a DB leak then
// cannot be replayed as live sessions (same reasoning as hashing passwords).
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

`sessions` has **no `restaurant_id`** and is **not** under RLS: it is resolved before the tenant
GUC is set, and `ON DELETE cascade` from `users` (which cascades from `restaurants`) keeps it tidy.

---

## 4. Password hashing & credentials

- `src/lib/auth/password.ts`: `hash(plain)` and `verify(hash, plain)` thin-wrap `@node-rs/argon2`
  (argon2id, library defaults).
- Email is **normalized** (trim + lowercase) before both storage and lookup, because
  `users.email` is globally unique (architecture D4: one human → one restaurant).
- Login returns a single generic error — `401 UNAUTHENTICATED` "invalid email or password" — for
  *both* unknown-email and wrong-password, to avoid user enumeration. Password is always verified
  (against a dummy hash when the email is unknown) so timing doesn't leak account existence.
- Registration password policy: `min 12` chars (from `api.md` `RegisterReq`).

---

## 5. Connection model + RLS (the crux)

### The bootstrap problem
RLS policies read a per-connection GUC, `app.restaurant_id`. But two operations must read the DB
**before any tenant is known**:
- **Login** looks up a user by globally-unique email (no tenant in hand yet).
- **Session resolution** (every request) reads `sessions ⨝ users` to *discover* the tenant.

If `users`/`sessions` were under RLS, those pre-tenant reads would return empty → nobody could log
in. Therefore those tables are **not** under RLS.

### Option Y — single role, RLS on the 6 data tables
- One DB role (`reg`, the table owner — Phase 0's existing connection). No second role/DSN.
- **RLS + `FORCE ROW LEVEL SECURITY`** on the 6 tables that carry `restaurant_id` and are only ever
  touched *after* the GUC is set: `documents`, `chunks`, `menu_items`, `modules`, `conversations`,
  `usage_events`. `FORCE` is required because the connecting role owns the tables (owners bypass RLS
  otherwise).
- `users`, `sessions`, `restaurants`: **no RLS**, protected by defense layers 1+2 (tenancy resolved
  from session, never client input; app-layer `WHERE restaurant_id = …` on tenant-scoped reads).
- Tables added in later phases (`messages`, `message_sources`, `module_progress` — no direct
  `restaurant_id`) get RLS in the phase that builds their data path, where it can be tested with
  real data.

### The policy (fails safe to empty, never errors)
```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <t>
  USING      (restaurant_id = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK (restaurant_id = current_setting('app.restaurant_id', true)::uuid);
```
The `true` (missing_ok) form means an **unset GUC → NULL → matches no rows** (a forgotten scope
returns *nothing*, not an error and not everything). `WITH CHECK` blocks inserting/updating a row
into another tenant.

### Setting the GUC — `withTenant` (David writes this)
```ts
export function withTenant<T>(restaurantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // transaction-local (true): auto-clears on commit/rollback, so it can NEVER
    // leak into the next request that reuses this pooled connection.
    await tx.execute(sql`select set_config('app.restaurant_id', ${restaurantId}, true)`);
    return fn(tx);
  });
}
```
The transaction-local flag is the single most important correctness detail in the phase: it is what
makes connection pooling + RLS safe together.

**Owned by David** (per CLAUDE.md — investor/interview-critical, must not be a black box):
the `withTenant` helper, the RLS policy SQL, and the tenant-scoped query pattern. Everything else is
scaffolded around them.

---

## 6. Request lifecycle & guards

```
POST/GET /api/...           cookie: sid=<token>
  └─ resolveSession()       sha256(token) → sessions ⨝ users ⨝ restaurants; check expiresAt
        │                   (system read — these tables aren't under RLS)
        ├─ none/expired → 401 UNAUTHENTICATED (and delete an expired row)
        └─ ok → { user, restaurant, role }
              └─ requireRole(min)   role rank owner(3) ≥ manager(2) ≥ trainee(1)
                    ├─ below → 403 FORBIDDEN
                    └─ ok → handler runs data queries via withTenant(restaurant.id, …)
```

- `src/lib/auth/guard.ts`: `requireSession(req)` and `requireRole(min)` — composable; protected
  handlers call them first and get a typed `{ user, restaurant }` or a thrown/returned error.
- All errors use the locked envelope from `api.md §1`:
  `{ error: { code, message, details? } }` with `UNAUTHENTICATED`(401), `FORBIDDEN`(403),
  `VALIDATION_ERROR`(400), `CONFLICT`(409), `INTERNAL`(500).
- Every body is parsed with a **Zod** schema at the top of the handler (`RegisterReq`, `LoginReq`
  from `api.md`); parse failure → `400 VALIDATION_ERROR` with field errors.

### Endpoint behavior
| Endpoint | Role | Behavior |
|---|---|---|
| `POST /api/auth/register` | public | txn: insert `restaurants`, insert `users`(owner, hashed pw); issue session; `201` + `Set-Cookie`; returns `{ user: PublicUser, restaurant }`. Duplicate email → `409 CONFLICT`. |
| `POST /api/auth/login` | public | verify argon2; issue session; `200` + `Set-Cookie`; returns `{ user, restaurant }`. Bad creds → `401`. |
| `POST /api/auth/logout` | any auth | delete session row, clear cookie; `204`. |
| `GET /api/auth/me` | any auth | `200 { user, restaurant }` (already in hand from `resolveSession`) or `401`. |

`PublicUser` = user without `password_hash` (a mapper enforces this; it is never serialized).

### Session details
- Token: 32 random bytes (`crypto.randomBytes`) → base64url = the cookie value.
- Cookie `sid`: HttpOnly, SameSite=Strict, Secure, Path=/, Max-Age 7d.
- Stored value: `sha256(token)` hex as `sessions.id`.
- Expiry: fixed 7 days, **no sliding renewal** (YAGNI for MVP). Logout deletes the row.

---

## 7. Module boundaries (small, single-purpose units)

| File | Purpose | Author |
|---|---|---|
| `schema.ts` | add `sessions` table | scaffold |
| `drizzle/0001_*.sql` | `sessions` DDL + RLS enable/force/policies on the 6 data tables | David (policy) |
| `src/lib/db.ts` | add `withTenant()` + scoped tx type | **David** |
| `src/lib/auth/password.ts` | `hash` / `verify` (argon2id) | scaffold |
| `src/lib/auth/session.ts` | token gen/hash, `create` / `resolve` / `revoke` | scaffold |
| `src/lib/auth/guard.ts` | `requireSession`, `requireRole` | scaffold |
| `src/lib/http/errors.ts` | error-envelope helpers | scaffold |
| `src/lib/auth/types.ts` | `PublicUser` mapper + Zod request schemas (or colocated) | scaffold |
| `src/app/api/auth/{register,login,logout,me}/route.ts` | the four handlers | scaffold |

New dependency: `@node-rs/argon2`. Test runner (vitest) added in implementation (§8).

---

## 8. Testing — the FR-004 deliverable

Tests are written with **vitest** (added in implementation) and run against the Docker Postgres.
"Done" for Phase 1 = these pass.

- **Unit**
  - `password`: `verify(hash(pw), pw)` true; wrong pw false; hash ≠ plaintext.
  - `session`: `resolve` returns the user for a fresh token; returns null past `expiresAt`;
    `revoke` then `resolve` → null.
- **Integration (happy + sad paths)**
  - register → `me` → logout → `me` is `401`.
  - login wrong password → `401`; unknown email → `401` (same message, no enumeration).
  - a `trainee` session hitting an owner-only route → `403`.
- **Isolation test (the proof of FR-004 / NFR "0 cross-tenant leaks")**
  - Seed restaurants A and B (no RLS on `restaurants`/`users`), then insert each `documents` row
    inside its own `withTenant(restaurant.id)` — which also exercises the policy's `WITH CHECK`.
  - Under `withTenant(A.id)`: `SELECT * FROM documents` returns **only A's** row.
  - Under `withTenant(A.id)`: fetch B's document by its id → **empty** (RLS backstop, not a 404 by
    app logic — the row is invisible at the DB).
  - A request carrying a forged `restaurant_id` in its body → **ignored**; scope still comes from
    the session.

---

## 9. Out of scope / known gaps (deliberate)

- **Login rate limiting / lockout** — FR-026, Phase 7. Noted as a known gap, not built now.
- **User management UI** (manager creates managers/trainees) — endpoints arrive when a phase needs
  them; `register` only creates the first owner. Adding those reads of `users` later may motivate
  upgrading to Option X (two roles) so `users` gets an RLS backstop too — a known door, not a wall.
- **Password reset / email verification** — not in MVP scope.
- **RLS on `messages` / `message_sources` / `module_progress`** — deferred to Phases 3/5 (no direct
  `restaurant_id`; needs subquery policies + real data to test).

---

## 10. Definition of done

Migration `0001` applies cleanly from scratch (extension already present from `0000`); `register`,
`login`, `logout`, `me` behave per §6; `tsc` clean and `next build` green; and **all of §8 passes**,
including the isolation test. Then Phase 1 is "runs, tested, and David can explain it" — specifically
the `withTenant` GUC mechanism and the fail-safe RLS policy.
