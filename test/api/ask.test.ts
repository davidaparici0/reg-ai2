import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { embedMock, generateMock } = vi.hoisted(() => ({
  embedMock: vi.fn(),
  generateMock: vi.fn(),
}));
vi.mock("@/lib/ai/embeddings", () => ({
  embed: embedMock, embeddingCostUsd: (t: number) => t * 1e-8,
  EMBEDDING_MODEL: "text-embedding-3-small", EMBEDDING_DIM: 1536,
}));
vi.mock("@/lib/ai/generate", () => ({
  generate: generateMock, completionCostUsd: () => 0, COMPLETION_MODEL: "gpt-4.1-mini",
}));

import { POST } from "@/app/api/ask/route";
import { db, withTenant } from "@/lib/db";
import { documents, chunks, messages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { registerOwner } from "../helpers/auth";
import { cleanup } from "../helpers/db";

afterEach(cleanup);
beforeEach(() => { embedMock.mockReset(); generateMock.mockReset(); });

const basis = (i: number) => { const v = Array(1536).fill(0); v[i] = 1; return v; };
const ask = (cookie: string | null, body: unknown) =>
  POST(new Request("http://x/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }));

describe("POST /api/ask", () => {
  it("401 without a session", async () => {
    const res = await ask(null, { question: "hi" });
    expect(res.status).toBe(401);
  });

  it("400 on an invalid body", async () => {
    const { cookie } = await registerOwner();
    const res = await ask(cookie, { question: "" });
    expect(res.status).toBe(400);
  });

  it("returns a grounded AskResponse and persists the turn", async () => {
    const { cookie, restaurant } = await registerOwner();
    const [doc] = await withTenant(restaurant.id, (tx) =>
      tx.insert(documents).values({
        restaurantId: restaurant.id, title: "Doc", sourceType: "text", contentHash: crypto.randomUUID(), status: "done",
      }).returning());
    await withTenant(restaurant.id, (tx) =>
      tx.insert(chunks).values({
        documentId: doc.id, restaurantId: restaurant.id, chunkIndex: 0, text: "the fact", tokenCount: 3, embedding: basis(0),
      }));
    embedMock.mockResolvedValue({ vectors: [basis(0)], usageTokens: 5 });
    generateMock.mockResolvedValue({ text: "Answer [1].", inputTokens: 40, outputTokens: 4 });

    const res = await ask(cookie, { question: "what is the fact?" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.grounded).toBe(true);
    expect(body.sources).toHaveLength(1);
    expect(typeof body.conversationId).toBe("string");
    expect(typeof body.messageId).toBe("string");

    const msgs = await withTenant(restaurant.id, (tx) =>
      tx.select().from(messages).where(eq(messages.conversationId, body.conversationId)));
    expect(msgs.map((m) => m.role).sort()).toEqual(["assistant", "user"]);
  });
});
