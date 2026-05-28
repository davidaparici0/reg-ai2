# REG AI — API Contracts (v1, Phase D)

**Status:** locks the *conventions* every endpoint inherits, and sketches the three
*signature contracts* the rest of the design depends on. Per-resource CRUD (menu,
modules, analytics) is intentionally **not** here — each gets defined at the top of
its feature phase, against a real slice, not guessed at now.

Style: **REST** over Next.js Route Handlers under `/api`. JSON in, JSON out
(uploads are `multipart/form-data`). The Zod schemas below **are** the contract —
validated at the boundary at runtime, inferred into TS types used on both client and
server, so the contract can't drift from the code.

---

## 1. Conventions (locked — decided once, inherited everywhere)

### Tenancy is never a client input  ← the one non-negotiable
No endpoint accepts `restaurant_id` in a body, param, query, or header. It is resolved
**server-side from the session**, always. A client cannot even *name* another tenant to
request its data. Combined with Phase 1's Row-Level Security, this is belt-and-suspenders
on the isolation requirement (FR-004 / FR-010).

### Auth
Cookie-based session (HTTPOnly, SameSite=Strict, Secure), resolved by a shared helper on
every protected route. Routes declare a minimum role; the guard rejects below it.
- `401` — not authenticated
- `403` — authenticated but wrong role / not your tenant's resource

### Validation
Every request body/query is parsed with a **Zod** schema at the top of the handler.
Parse failure → `400` with the field errors. No hand-rolled checks; the schema is the
single source of truth, and `z.infer` gives the TS type the client imports.

### Success shapes
- Single resource: the object directly — `{ "id": "...", ... }`
- Collection: `{ "items": [...], "nextCursor": string | null }` (cursor pagination)
- Action with no body: `204 No Content`

### Error shape (consistent envelope)
```jsonc
{ "error": { "code": "VALIDATION_ERROR", "message": "human-readable", "details": {} } }
```
`code` is a stable machine string; `message` is for humans; `details` is optional
(e.g. Zod field errors). Codes: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401),
`FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `RATE_LIMITED` (429),
`INTERNAL` (500). AI calls fail gracefully into this envelope — never a naked crash.

### Status codes
`200` ok · `201` created · `204` no content · `400/401/403/404/409/429` as above ·
`202 Accepted` specifically for async work that's been queued (ingestion).

---

## 2. Signature contracts (sketched now — they shape the other docs)

### 2.1 Auth

```ts
// POST /api/auth/register  — creates a restaurant + its FIRST owner. Public.
// (Trainees/managers are created BY a manager later, not via self-register.)
const RegisterReq = z.object({
  restaurantName: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(12),       // hashed argon2/bcrypt server-side, Phase 1
});
// 201 -> sets session cookie, returns { user: PublicUser, restaurant: Restaurant }

// POST /api/auth/login  — Public.
const LoginReq = z.object({ email: z.string().email(), password: z.string() });
// 200 -> sets session cookie, returns { user: PublicUser, restaurant: Restaurant }

// POST /api/auth/logout  -> 204, clears the cookie.
// GET  /api/auth/me      -> 200 { user: PublicUser, restaurant: Restaurant } | 401
// PublicUser NEVER includes password_hash.
```

### 2.2 Document upload + ingestion status (the async pattern, FR-005/009)

Upload returns immediately with a job in `pending`; ingestion (parse → chunk → embed)
runs in the background worker. The client polls status. Tenancy and uploader come from
the session, never the request.

```ts
// POST /api/documents   — owner|manager. Content-Type: multipart/form-data
//   fields: file (PDF for MVP), title?
//   validated server-side: mime in {pdf}, size <= limit. Not a Zod body (it's a file).
// 202 Accepted ->
type UploadAccepted = { documentId: string; status: "pending" };

// GET /api/documents/:id  — owner|manager, must be this tenant's document.
type DocumentStatus = {
  id: string;
  title: string;
  status: "pending" | "processing" | "done" | "failed";
  error: string | null;       // populated when status = failed
  chunkCount: number | null;  // populated when status = done
};

// GET /api/documents  — owner|manager. -> { items: DocumentStatus[]; nextCursor }
```

### 2.3 Ask — grounded Q&A (the crown jewel, FR-010–014)

**JSON first, streaming later.** A deterministic `{ answer, grounded, sources }` body is
what we test and run the eval set against. Token streaming is a Phase-3-polish UX layer on
top of the same logic — sources are known from retrieval *before* generation, so streaming
adds nothing to the contract's substance.

```ts
// POST /api/ask  — any authenticated role. Tenant from session.
const AskReq = z.object({
  question: z.string().min(1).max(2000),
  conversationId: z.string().uuid().optional(), // omitted -> start a new conversation
});

type Source = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  snippet: string;     // the cited chunk text (or a window of it)
  similarity: number;  // cosine score at retrieval time
};

type AskResponse = {
  answer: string;
  grounded: boolean;        // false when retrieval was too weak -> answer is the honest
                            //   "not in your materials / ask your manager" fallback (FR-012)
  sources: Source[];        // [] when grounded = false
  conversationId: string;
  messageId: string;        // the assistant message; message_sources rows link it to chunks
};
// On the safety path (allergen/food-safety) a weak/uncertain retrieval MUST resolve to
// grounded=false rather than a hedged guess (FR-014).
```

`grounded` is the field the frontend keys off to render a confident, cited answer vs. a
visibly-flagged "check with your manager" state. It's the contract-level expression of
grounding-over-fluency.

---

## 3. Deferred — defined at the start of their phase (not now)

| Surface | Phase | Why deferred |
|---|---|---|
| Menu CRUD (`/api/menu-items`) | 4 | Shape depends on how menu data feeds retrieval — a Phase 4 decision |
| Module CRUD + progress (`/api/modules`, `/api/progress`) | 5 | Module content structure isn't firmed up until Phase 5 |
| Analytics/dashboard (`/api/analytics/*`) | 6 | Aggregations defined once we know what signals exist to aggregate |
| Streaming variant of `/api/ask` | 3 (polish) | JSON contract proven first; streaming is additive UX |

All inherit the Section 1 conventions automatically. Each will be added here as a short
block when its phase opens — same Zod-schema-is-the-contract style.
