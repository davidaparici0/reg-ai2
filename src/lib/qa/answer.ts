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

// CALIBRATED 2026-06-12 against eval/eval-set.yaml (see eval:run distribution + rag.md §4).
// The eval showed an INVERTED gap: hardest answerable (Q05, safety) top1=0.4906 sits BELOW the
// hardest fallback (Q08, topical near-miss) at 0.5267 — similarity measures topicality, not
// answerability, so no threshold separates that class. Strategy: the gate is layer 1 of two.
// 0.46 sits in the clean window (0.4223, 0.4906] — biased UP from the 0.4565 midpoint per the
// safety rule — so every answerable question clears (Q05 +0.031) and the safety-critical
// fallback Q13 declines deterministically (+0.038 margin). Above-gate topical near-misses
// (Q08-class) are layer 2's job: the prompt's decline rule, probe-verified to emit
// FALLBACK_TEXT exactly. Recalibrate whenever the embedding model or corpus shape changes.
export const THRESHOLD = 0.46;
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
