// Seeds the rows /api/ask would write, WITHOUT calling OpenAI. message_sources requires a real
// chunk (FK), so seedChunk makes one document+chunk per tenant to anchor grounded answers.
import { withTenant } from "@/lib/db";
import {
  conversations, messages, messageSources, documents, chunks, usageEvents,
} from "@/db/schema";

const ZERO_VEC = Array(1536).fill(0);

export async function seedChunk(rid: string): Promise<string> {
  return withTenant(rid, async (tx) => {
    const [doc] = await tx.insert(documents).values({
      restaurantId: rid, title: "SOP", sourceType: "text", contentHash: crypto.randomUUID(), status: "done",
    }).returning();
    const [chunk] = await tx.insert(chunks).values({
      documentId: doc.id, restaurantId: rid, chunkIndex: 0, text: "x", tokenCount: 1, embedding: ZERO_VEC,
    }).returning();
    return chunk.id;
  });
}

// One Q&A: conversation (owned by userId) + user msg + assistant msg, all at createdAt.
// grounded=true also writes a message_sources row (=> counted grounded) and a completion usage event.
// Every ask writes one embedding usage event (mirrors the real pipeline).
export async function seedAsk(opts: {
  rid: string; userId: string; chunkId: string; grounded: boolean; createdAt?: Date;
}): Promise<string> {
  const { rid, userId, chunkId, grounded } = opts;
  const createdAt = opts.createdAt ?? new Date();
  return withTenant(rid, async (tx) => {
    const [conv] = await tx.insert(conversations).values({ restaurantId: rid, userId }).returning();
    await tx.insert(messages).values({ conversationId: conv.id, restaurantId: rid, role: "user", content: "q", createdAt });
    const [a] = await tx.insert(messages).values({
      conversationId: conv.id, restaurantId: rid, role: "assistant", content: grounded ? "answer" : "fallback", createdAt,
    }).returning();
    if (grounded) {
      await tx.insert(messageSources).values({ messageId: a.id, chunkId, restaurantId: rid, similarity: 0.7 });
    }
    await tx.insert(usageEvents).values({
      restaurantId: rid, userId, kind: "embedding", model: "text-embedding-3-small",
      inputTokens: 10, outputTokens: 0, costUsd: "0.000020", createdAt,
    });
    if (grounded) {
      await tx.insert(usageEvents).values({
        restaurantId: rid, userId, kind: "completion", model: "gpt-4.1-mini",
        inputTokens: 100, outputTokens: 20, costUsd: "0.010000", createdAt,
      });
    }
    return a.id;
  });
}
