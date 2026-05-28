# REG AI — Architecture (v1, Phase D)

**Status:** the one-page map of how the system fits together, plus the home for the
cross-cutting decisions we've made but deferred to implement. Keep it lean. The detail
of *what* lives where is in the spec, schema, and API docs; this is *how it runs*.

---

## 1. Shape

One TypeScript codebase. Next.js 15 (App Router) is both the frontend and the API
(Route Handlers). One Postgres 16 + pgvector database holds relational data **and**
embeddings. Ingestion runs **outside** the request path in a long-running worker.

```
Browser ── React UI (reuse prototype's shadcn components)
   │  HTTPS, cookie session
   ▼
Next.js Route Handlers (/api)  ── auth · tenancy · menu · modules · analytics · ask
   │                                     │ enqueue ingestion job
   │ SQL + vector search                 ▼
   │                            Background worker (parse → chunk → embed)
   ▼                                     │
PostgreSQL 16 + pgvector  ◄──────────────┘
   ▲
   │ server-side key (never the client)
LLM + embeddings provider
```

Why one app, one DB: the surface is small and resource-shaped; a second service or a
separate vector store would be machinery we haven't earned. Shared TS types across
client/server are the payoff of staying single-language.

---

## 2. Two flows that matter

**Ask (synchronous, must be fast — P95 < 4s):**
embed question → tenant-scoped top-k vector search → if top similarity ≥ threshold,
build prompt from chunks + call LLM (server key) → persist message + `message_sources`
→ return `{ answer, grounded, sources }`. Below threshold → `grounded:false` fallback,
no LLM guess. Details in `docs/rag.md`.

**Ingestion (asynchronous, can be slow):**
upload returns `202` immediately with a `pending` document → worker parses → chunks
deterministically → embeds → writes `chunks` → marks `done` (or `failed` + error).
It runs in a long-running process, **not** a serverless request, because parse+embed
can exceed serverless timeouts. This is the one TS-path gotcha; the worker is where it's
handled. Deployment target is Fly.io/Railway (long-running friendly).

---

## 3. Tenant isolation — defense in depth

Isolation is the product's core promise, so it's enforced at three layers, not one:
1. **API**: tenancy is never a client input — `restaurant_id` comes from the session.
2. **Query**: every query filters on `restaurant_id` (denormalized onto `chunks` for the
   hot path).
3. **Database (RLS)**: Row-Level Security as the backstop — see decision D1.

A cross-tenant leak therefore requires multiple independent failures, not one.

---

## 4. Parked decisions (made now, implemented later)

### D1 — Row-Level Security: adopt, implement in Phase 1
**Decision:** use Postgres RLS as defense-in-depth so a forgotten `WHERE restaurant_id`
returns *nothing* instead of *everything*.
**Why Phase 1, not now:** RLS policies read a per-connection session GUC
(`current_setting('app.restaurant_id')`). Something must *set* that GUC on every request —
the tenant-resolution middleware built in Phase 1. Policies without it lock everyone out.
**Plan:** in the Phase 1 migration, enable RLS on every tenant-scoped table and add a policy
keyed on the GUC; the auth layer sets the GUC per request. Cost acknowledged: every
connection must set it; an unset GUC yields empty results (a new "why is my query empty"
failure mode to teach/debug).

### D2 — Filtered-HNSW recall: tune in Phase 3, harden in Phase 7
**Risk:** HNSW walks the index *then* applies the `restaurant_id` filter. If a tenant's
chunks are sparse vs. the whole corpus, the candidate set can be mostly other tenants,
get filtered away, and return fewer than `k` (or lower-quality) results — worsening as
tenants grow. Detail and the mitigation ladder live in `docs/rag.md`; the **eval set** is
the instrument that tells us if it's actually biting. Ladder: raise `hnsw.ef_search` →
pgvector 0.8+ iterative scans → (post-MVP) hash-partition `chunks` by tenant.

### D3 — Partitioning: post-MVP, not now
`usage_events` (monthly range partition) and `chunks` (hash partition by `restaurant_id`)
are the first partition candidates once volume/retention demand it. The denormalized
`restaurant_id` on `chunks` is what keeps the chunks option open — a point in its favor.
Not MVP; revisit when a real tenant's data volume makes it concrete.

### D4 — Global-unique email: known door
`users.email` is globally unique, which hard-locks "one human, one restaurant" — correct
for v1 (chains are out of scope). The eventual chain-support migration (drop global unique,
add `unique(restaurant_id, email)`, dedup collisions) is painful. Recorded here so it's a
known door, not a surprise wall.

---

## 5. Secrets & cost

The LLM/embeddings key is the business's, used server-side only, billed centrally, never
shipped to the client and never logged (the prototype got this wrong). Every model call
writes a `usage_events` row so $/answer is observable per restaurant from day one —
the metric the $49.99/mo price point lives or dies on.

---

## 6. What this doc deliberately omits

No scaling architecture for 10k restaurants, no caching tier, no queue-vs-cron decision
locked beyond "long-running worker," no multi-region. Those are problems we'll have when
we're lucky enough to have them. Revisit only with a concrete reason.
