import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module mocks use ARROW factories (only constructor mocks need a regular function).
const embedMock = vi.fn();
const generateMock = vi.fn();
vi.mock("@/lib/ai/embeddings", () => ({
  embed: embedMock,
  embeddingCostUsd: (t: number) => t * 1e-8,
  EMBEDDING_MODEL: "text-embedding-3-small",
  EMBEDDING_DIM: 1536,
}));
vi.mock("@/lib/ai/generate", () => ({
  generate: generateMock,
  completionCostUsd: () => 0,
  COMPLETION_MODEL: "gpt-4.1-mini",
}));

import { db, withTenant } from "@/lib/db";
import { restaurants, users, documents, chunks, messageSources, usageEvents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);
beforeEach(() => { embedMock.mockReset(); generateMock.mockReset(); });

const basis = (i: number) => { const v = Array(1536).fill(0); v[i] = 1; return v; };

async function seedTenant(name: string, withChunk: boolean) {
  const [r] = await db.insert(restaurants).values({ name }).returning();
  track(r.id);
  const [u] = await db.insert(users).values({
    restaurantId: r.id, email: `${crypto.randomUUID()}@t.test`, passwordHash: "x", role: "owner",
  }).returning();
  if (withChunk) {
    const [doc] = await withTenant(r.id, (tx) =>
      tx.insert(documents).values({
        restaurantId: r.id, title: "Doc", sourceType: "text", contentHash: `${name}-${crypto.randomUUID()}`, status: "done",
      }).returning());
    await withTenant(r.id, (tx) =>
      tx.insert(chunks).values({
        documentId: doc.id, restaurantId: r.id, chunkIndex: 0, text: "the relevant fact", tokenCount: 5, embedding: basis(0),
      }));
  }
  return { id: r.id, userId: u.id, name };
}

describe("answer()", () => {
  it("grounded path: generates, persists sources + 2 usage rows", async () => {
    const t = await seedTenant("ANSA", true);
    embedMock.mockResolvedValue({ vectors: [basis(0)], usageTokens: 7 });
    generateMock.mockResolvedValue({ text: "The fact is X [1].", inputTokens: 50, outputTokens: 6 });
    const { answer } = await import("@/lib/qa/answer");

    const res = await withTenant(t.id, (tx) => answer(tx, {
      restaurantId: t.id, userId: t.userId, restaurantName: t.name, question: "what is the fact?",
    }));

    expect(res.grounded).toBe(true);
    expect(res.answer).toBe("The fact is X [1].");
    expect(res.sources).toHaveLength(1);
    expect(res.sources[0].snippet).toBe("the relevant fact");
    expect(generateMock).toHaveBeenCalledOnce();

    const srcRows = await withTenant(t.id, (tx) =>
      tx.select().from(messageSources).where(eq(messageSources.messageId, res.messageId)));
    expect(srcRows).toHaveLength(1);
    const usage = await withTenant(t.id, (tx) => tx.select().from(usageEvents));
    expect(usage.map((u) => u.kind).sort()).toEqual(["completion", "embedding"]);
  });

  it("weak retrieval: falls back WITHOUT calling the model, no completion usage", async () => {
    const t = await seedTenant("ANSB", false); // no chunks -> empty retrieval
    embedMock.mockResolvedValue({ vectors: [basis(0)], usageTokens: 7 });
    const { answer } = await import("@/lib/qa/answer");
    const { FALLBACK_TEXT } = await import("@/lib/qa/prompt");

    const res = await withTenant(t.id, (tx) => answer(tx, {
      restaurantId: t.id, userId: t.userId, restaurantName: t.name, question: "anything?",
    }));

    expect(res.grounded).toBe(false);
    expect(res.answer).toBe(FALLBACK_TEXT);
    expect(res.sources).toEqual([]);
    expect(generateMock).not.toHaveBeenCalled();
    const usage = await withTenant(t.id, (tx) => tx.select().from(usageEvents));
    expect(usage.map((u) => u.kind)).toEqual(["embedding"]);
  });

  it("model declines from context (above threshold) -> grounded:false, no sources, completion still billed", async () => {
    const t = await seedTenant("ANSC", true);
    const { FALLBACK_TEXT } = await import("@/lib/qa/prompt");
    embedMock.mockResolvedValue({ vectors: [basis(0)], usageTokens: 7 });
    generateMock.mockResolvedValue({ text: FALLBACK_TEXT, inputTokens: 50, outputTokens: 6 });
    const { answer } = await import("@/lib/qa/answer");

    const res = await withTenant(t.id, (tx) => answer(tx, {
      restaurantId: t.id, userId: t.userId, restaurantName: t.name, question: "what is the fact?",
    }));

    expect(res.grounded).toBe(false);
    expect(res.sources).toEqual([]);
    expect(generateMock).toHaveBeenCalledOnce();
    const usage = await withTenant(t.id, (tx) => tx.select().from(usageEvents));
    expect(usage.map((u) => u.kind).sort()).toEqual(["completion", "embedding"]);
  });
});
