# REG AI — RAG Design (v1, Phase D)

**Status:** the design of the signature feature. Pins down the parameters and rules of
the retrieval pipeline. **Two things are explicitly left as a first draft for David to
finalize** — the *similarity threshold* and the *prompt template* — because they are what
make REG AI work and what he'll be asked to defend. Everything else is settled.

The pipeline: `question → embed → tenant-scoped top-k search → threshold gate → (prompt
from chunks → LLM) OR fallback → persist with sources`.

---

## 1. Chunking (deterministic — FR-006)

- **Split on natural boundaries first** (paragraphs / list items / menu entries), then
  pack into token-bounded chunks. Don't blind-cut every N characters — a chunk that
  splits an allergen list mid-sentence retrieves badly.
- **Target ~500 tokens per chunk, ~15% overlap (~75 tokens).** Big enough to hold a full
  dish description or an SOP step with its context; small enough that a top-k of 5 fits
  the prompt cheaply. Tunable against the eval set.
- **Deterministic:** same normalized text in → same chunks out, every time. This is what
  makes the document-level `content_hash` dedup meaningful (FR-008) and re-ingestion safe.
- **Store `token_count` per chunk** (we already do) so prompt-budget math is exact.

## 2. Embedding (LOCKED — FR-007)

- **Model:** OpenAI `text-embedding-3-small`. **Dimension:** 1536 (matches the schema's
  `vector(1536)`). **Distance:** cosine — pgvector `<=>` returns cosine *distance*;
  **similarity = 1 − distance**, and the threshold below is expressed as similarity.
- **Why this model:** cheap (matters at $49.99/mo), strong enough for a domain-specific
  corpus, common dimension. Upgrading to `-3-large` is a deliberate migration, not a flag.
- Same model is used for **both** indexing chunks and embedding the incoming question —
  they must share an embedding space or retrieval is meaningless.

## 3. Retrieval (tenant-scoped — FR-010)

```sql
SELECT id, document_id, text, 1 - (embedding <=> $queryEmb) AS similarity
FROM chunks
WHERE restaurant_id = $restaurantId
ORDER BY embedding <=> $queryEmb
LIMIT $k;          -- start k = 5
```

`restaurant_id` is the first predicate — isolation is in the query, backed by RLS (D1).
`k = 5` is the starting point: enough recall to answer, few enough to keep the prompt
cheap and fast. Tune against the eval set's retrieval hit-rate.

### Filtered-HNSW recall (decision D2 — watch this)
HNSW walks the index, *then* applies the `restaurant_id` filter, so a sparse tenant can
get back candidates that are mostly other tenants and end up with **< k** results. The
eval set is how we detect it. Mitigation ladder, cheapest first:
1. Raise `hnsw.ef_search` (buys recall headroom, costs a little latency).
2. pgvector **0.8+ iterative index scans** (`hnsw.iterative_scan`) — built for filtered search.
3. (post-MVP) hash-partition `chunks` by `restaurant_id`.
Address when building retrieval (Phase 3); harden in Phase 7.

---

## 4. The grounding threshold  ⟵ **YOURS TO FINALIZE, David**

This is the single most consequential number in the product. It's the cutoff that decides
`grounded: true` (answer from context) vs `grounded: false` (honest fallback, no LLM guess).
- **Too high** → the system refuses questions it could actually answer. Annoying, but safe.
- **Too low** → it answers from weak/irrelevant chunks → hallucination. The failure that
  kills the value prop.

**It cannot be guessed — it must be calibrated against the eval set.** The method:
1. Run all 15 eval questions through retrieval, record the top-1 similarity for each.
2. The answerable questions should cluster *above* some value; the three deliberate-fallback
   questions (Q08, Q13, Q15) should sit *below* it. The threshold is the gap between them.
3. When safety-critical (allergen/food-safety) questions are near the line, **bias toward
   refusing** — a missed answer is recoverable, a wrong allergen answer is not.

**Starting placeholder (NOT a settled value):** gate on **top-1 similarity ≥ ~0.35**, and
require at least one chunk above it. Treat this as a hypothesis to confirm or move once you
see the eval distribution — own the final number; it's exactly what you'll be asked to justify.

---

## 5. The prompt template  ⟵ **YOURS TO FINALIZE, David**

Per the AI-usage discipline: write this yourself and make it yours. Below is a *first draft*
to react to — the rules it encodes (answer only from context, cite, decline otherwise,
extra caution on safety) are the requirements; the wording is yours.

```text
SYSTEM:
You are a training assistant for {restaurant_name}. Answer ONLY using the numbered
context below, which comes from this restaurant's own materials. 

Rules:
- If the context does not contain the answer, reply exactly: "I don't have that in
  {restaurant_name}'s materials — please check with your manager." Do not use outside
  knowledge. Do not guess.
- Cite the context you used by its [number].
- For allergens, dietary, or food-safety questions: only state what the context explicitly
  says. If it is incomplete or absent, say so and advise confirming with the kitchen/manager.
  Never reassure that something is "safe" beyond what the context supports.
- Be concise and practical — staff may be reading this mid-shift.

CONTEXT:
[1] {chunk_1_text}
[2] {chunk_2_text}
...

USER:
{question}
```

Notes on why each rule exists:
- *"Answer ONLY from context"* + the exact refusal string is the grounding/fallback (FR-012)
  expressed in the prompt — it's the backstop even when retrieval squeaks above threshold.
- *Citation by [number]* maps cleanly to `message_sources`: we know which chunk each [n] is.
- The *allergen clause* is FR-014; it's deliberately the most conservative rule in the prompt.

---

## 6. Fallback & safety behavior (FR-012 / FR-014)

- **Weak retrieval** (below §4 threshold) → return `grounded:false` with the fallback string
  and empty `sources`; **don't call the LLM at all** (saves cost and removes the temptation
  for it to improvise).
- **Above threshold** → call the LLM with §5; if it still can't answer from context, the
  prompt makes it emit the refusal string → treat as `grounded:false`.
- **Safety-critical questions** near the line resolve to `grounded:false`, not a hedge.
- Every answer (grounded or fallback) persists a `messages` row; grounded answers also write
  `message_sources` linking the cited chunks + their similarity — the audit trail.

## 7. How we know it works (the eval gate)

`eval/eval-set.yaml` is the ruler. A pipeline change is judged by: retrieval hit-rate
(expected source in top-k) ≥ 90% on answerable questions; 100% of the fallback questions
correctly decline; 0 fabricated safety facts. Wired into CI in Phase 8 so a regression
fails the build. Re-run it whenever chunking, k, the threshold, or the prompt changes.

---

## 8. Cost & latency notes

- One embedding call per question + one completion per grounded answer; fallbacks cost only
  the embedding (no completion). Every call writes `usage_events`.
- Latency budget (P95 < 4s): embedding + vector search are single-digit-to-tens of ms;
  the LLM completion dominates — keep `k` and prompt size modest, and consider a cheaper/
  faster model for the completion if eval quality holds (Phase 7).
