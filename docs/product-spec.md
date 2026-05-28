# REG AI — Product Spec (v1, Phase D)

**Status:** lean lock for the MVP build. This is the source of truth for *what* the
app must do. The Drizzle schema, architecture, and RAG design all serve this list.
Keep it tight — refine only with a concrete reason, not because something new is shiny.

---

## 1. Scope

**What REG AI is (MVP):** a multi-tenant SaaS where a fine-dining restaurant uploads
its own training material and menu, and its staff get instant answers **grounded in
that restaurant's material**, with managers able to manage content and see activity.

**In scope for MVP (Phases 0–3 are the spine):**
- Restaurant tenants, users with roles, login
- Upload + ingest training docs (PDF first)
- Grounded, cited Q&A with an honest "I'm not sure" fallback
- Structured menu with allergens; menu-aware answers
- Basic training modules + per-trainee progress
- Manager analytics + per-restaurant usage/cost

**Explicitly OUT of scope for MVP (anti-scope-creep list):**
- Native mobile apps, offline mode
- Payment/billing integration (price is fixed at $49.99/mo; collect manually for pilots)
- Multi-restaurant chains / org hierarchies beyond a single tenant
- Custom model fine-tuning or self-hosted embedding models
- Real-time collaboration, notifications, SSO
- Adaptive/recommendation engine beyond a simple rules-based suggestion

If a request lands in the OUT list, it's a "later when we're lucky enough to need it"
item, not a v1 task.

---

## 2. Personas

| Persona | Role values | What they do |
|---|---|---|
| Owner / Manager | `owner`, `manager` | Upload material, manage menu, build modules, view analytics. The buyer. |
| Trainee / Staff | `trainee` | Ask questions, complete modules. The end user. |

---

## 3. Functional Requirements

Each FR has an acceptance criterion (how we know it's done) and the phase that ships it.
**MVP** = required for a working, demoable product. **Stretch** = after the spine works.

### Auth & Tenancy — Phase 1
| FR | Requirement | Acceptance criterion | Tier |
|---|---|---|---|
| FR-001 | Create a restaurant (tenant) | A restaurant row + settings can be created and fetched | MVP |
| FR-002 | Create users + login with hashed passwords | Password stored as argon2/bcrypt hash; valid login returns a session | MVP |
| FR-003 | Roles: owner / manager / trainee | Role stored per user; route guards enforce role on protected routes | MVP |
| FR-004 | Tenant-scoped access on every request | A user from restaurant A cannot read/return restaurant B's data (tested) | MVP |

### Document Ingestion — Phase 2
| FR | Requirement | Acceptance criterion | Tier |
|---|---|---|---|
| FR-005 | Upload PDF/DOCX/text | Owner/manager uploads a file; a `documents` row is created | MVP (PDF), Stretch (DOCX/text) |
| FR-006 | Parse + chunk deterministically | Same file → same chunks every time (fixed strategy) | MVP |
| FR-007 | Embed + store in pgvector | Each chunk has an embedding stored with its `restaurant_id` | MVP |
| FR-008 | Content-hash dedup | Re-uploading the same file creates **no** duplicate chunks | MVP |
| FR-009 | Ingestion job status + errors | Job moves pending→processing→done/failed; errors captured; runs in background | MVP |

### Retrieval & Q&A (the signature feature) — Phase 3
| FR | Requirement | Acceptance criterion | Tier |
|---|---|---|---|
| FR-010 | Tenant-scoped top-k vector search | Search returns only the asking restaurant's chunks | MVP |
| FR-011 | Grounded answer with citations (server-side key) | Answer is built from retrieved chunks and cites them; key never on client | MVP |
| FR-012 | "I'm not sure" fallback on weak retrieval | Below similarity threshold → decline, don't guess (eval Q08/Q13/Q15) | MVP |
| FR-013 | Conversation history | Q&A persists per trainee with the chunks that grounded each answer | MVP |
| FR-014 | Allergen/food-safety caution | Safety-critical answers are conservative + source-backed (eval Q02–Q05, Q12) | MVP |

### Menu — Phase 4
| FR | Requirement | Acceptance criterion | Tier |
|---|---|---|---|
| FR-015 | Structured menu CRUD | Manager can create/edit/delete items incl. allergens + dietary flags | MVP |
| FR-016 | Menu-aware answers | Q&A can answer from structured menu data, cited | MVP |
| FR-017 | Menu changes reflected immediately | Editing an item updates its embeddings/answers without manual re-ingest | MVP |

### Training Modules — Phase 5
| FR | Requirement | Acceptance criterion | Tier |
|---|---|---|---|
| FR-018 | Module CRUD aligned to menu/standards | Manager creates ordered modules, optionally tied to docs/menu items | MVP |
| FR-019 | Per-trainee progress | Progress stored per (trainee, module): started/completed/score | MVP |
| FR-020 | Adaptive next-step suggestion | Rules-based "what to study next" | Stretch |

### Analytics — Phase 6
| FR | Requirement | Acceptance criterion | Tier |
|---|---|---|---|
| FR-021 | Per-trainee activity/comprehension | Manager sees questions asked, modules completed per trainee | MVP |
| FR-022 | Manager dashboard data | Tenant-scoped, manager/owner-only data endpoints | MVP |
| FR-023 | Usage/cost reporting | Per-restaurant LLM/embedding usage + cost rollups | MVP |

### System — Phases 0, 7, 8
| FR | Requirement | Acceptance criterion | Tier |
|---|---|---|---|
| FR-024 | Health check | `GET /api/health` confirms DB + pgvector | MVP (Phase 0) |
| FR-025 | Structured logging | Requests/jobs logged in structured form; secrets never logged | MVP |
| FR-026 | Per-tenant rate limiting | Per-restaurant limits + request/size caps enforced | Stretch (Phase 7) |
| FR-027 | Metrics: latency, cost, retrieval quality | Observable per request; eval gate in CI | MVP gate, full in Phase 7/8 |

---

## 4. Non-Functional Requirements (the bar)

| NFR | Target | Why |
|---|---|---|
| Answer latency | P50 < 2s, P95 < 4s end-to-end | A slow training tool doesn't get used mid-shift |
| Retrieval quality | Expected source in top-k for ≥ 90% of the eval set | The product's core promise |
| Grounding/safety | 0 fabricated allergen/food-safety facts; cite or decline | A wrong allergen answer is a safety incident |
| Tenant isolation | 0 cross-tenant leaks (tested, not assumed) | Security + competitive-trust requirement |
| Cost | Track $/answer; sustainable at $49.99/restaurant/mo | Unit economics must survive the price point |
| Secrets | LLM/embeddings key server-side only, never logged | The prototype got this wrong; we don't |

---

## 5. Traceability (so nothing drifts)

- **Every FR maps to a phase** (column above) → the build order is the spec order.
- **Behaviors are checked by the eval set** (`eval/eval-set.yaml`): grounding (FR-011),
  fallback (FR-012 → Q08/Q13/Q15), safety (FR-014 → Q02–Q05/Q12), isolation (FR-004/FR-010).
- **The schema must support exactly these FRs and no more** — if a table doesn't trace
  to an FR, question whether it belongs in v1.

---

## 6. Definition of "MVP done"

A seeded demo restaurant exists; a manager can upload a menu + a training doc; a trainee
can ask a real question and get a correct, cited answer; an out-of-materials question gets
an honest decline; a second restaurant's data never appears in the first's answers; the
eval set passes its retrieval target in CI; and it's deployed at a public URL. (That's
Phase 8 — but it's defined here so we always know what we're building toward.)
