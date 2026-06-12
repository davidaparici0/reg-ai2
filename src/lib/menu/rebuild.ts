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
