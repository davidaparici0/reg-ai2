// test/lib/menu-rebuild.test.ts
// DB test (Docker Postgres). Embeddings mocked — vectors are deterministic basis vectors.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { embedMock } = vi.hoisted(() => ({ embedMock: vi.fn() }));
vi.mock("@/lib/ai/embeddings", () => ({
  embed: embedMock, embeddingCostUsd: (t: number) => t * 1e-8,
  EMBEDDING_MODEL: "text-embedding-3-small", EMBEDDING_DIM: 1536,
}));

import { eq, and, asc } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { documents, chunks, menuItems, usageEvents } from "@/db/schema";
import { ensureMenuDocument, lockMenuRebuild, rebuildMenuChunks, menuDocContentHash } from "@/lib/menu/rebuild";
import { registerOwner } from "../helpers/auth";
import { cleanup } from "../helpers/db";

afterEach(cleanup);
beforeEach(() => {
  embedMock.mockReset();
  // Return one distinct basis vector per input card, in order.
  embedMock.mockImplementation(async (texts: string[]) => ({
    vectors: texts.map((_, i) => { const v = Array(1536).fill(0); v[i] = 1; return v; }),
    usageTokens: texts.length * 10,
  }));
});

async function insertItem(rid: string, name: string, active = true) {
  return withTenant(rid, (tx) =>
    tx.insert(menuItems).values({ restaurantId: rid, name, active }).returning());
}

describe("rebuildMenuChunks", () => {
  it("creates the Menu doc on first run and one chunk per active item, name-ordered", async () => {
    const { restaurant, user } = await registerOwner();
    await insertItem(restaurant.id, "Zucchini Tart");
    await insertItem(restaurant.id, "Apple Salad");

    await withTenant(restaurant.id, async (tx) => {
      await lockMenuRebuild(tx, restaurant.id);
      await rebuildMenuChunks(tx, restaurant.id, user.id);
    });

    const [doc] = await withTenant(restaurant.id, (tx) =>
      tx.select().from(documents)
        .where(and(eq(documents.restaurantId, restaurant.id),
                   eq(documents.contentHash, menuDocContentHash(restaurant.id)))));
    expect(doc).toBeDefined();
    expect(doc.title).toBe("Menu");
    expect(doc.status).toBe("done");

    const rows = await withTenant(restaurant.id, (tx) =>
      tx.select().from(chunks).where(eq(chunks.documentId, doc.id)).orderBy(asc(chunks.chunkIndex)));
    expect(rows).toHaveLength(2);
    expect(rows[0].chunkIndex).toBe(0);
    expect(rows[0].text.startsWith("Dish: Apple Salad.")).toBe(true);   // name asc
    expect(rows[1].text.startsWith("Dish: Zucchini Tart.")).toBe(true);

    const usage = await withTenant(restaurant.id, (tx) =>
      tx.select().from(usageEvents).where(eq(usageEvents.restaurantId, restaurant.id)));
    expect(usage.some((u) => u.kind === "embedding" && u.userId === user.id)).toBe(true);
  });

  it("is idempotent + deterministic: a second rebuild replaces the set with identical cards", async () => {
    const { restaurant, user } = await registerOwner();
    await insertItem(restaurant.id, "Soup");
    const run = () => withTenant(restaurant.id, async (tx) => {
      await lockMenuRebuild(tx, restaurant.id);
      await rebuildMenuChunks(tx, restaurant.id, user.id);
    });
    const doc = await withTenant(restaurant.id, async (tx) =>
      ensureMenuDocument(tx, restaurant.id));
    const texts = () => withTenant(restaurant.id, (tx) =>
      tx.select({ text: chunks.text }).from(chunks)
        .where(eq(chunks.documentId, doc.id)).orderBy(asc(chunks.chunkIndex)));
    await run();
    const first = await texts();
    await run();
    const second = await texts();
    expect(second).toHaveLength(1);            // replaced, not duplicated
    expect(second).toEqual(first);             // same items => byte-identical card list (spec §7)
  });

  it("inactive items get no card; zero active items embeds nothing", async () => {
    const { restaurant, user } = await registerOwner();
    await insertItem(restaurant.id, "Eighty-Sixed", false);
    await withTenant(restaurant.id, async (tx) => {
      await lockMenuRebuild(tx, restaurant.id);
      await rebuildMenuChunks(tx, restaurant.id, user.id);
    });
    const doc = await withTenant(restaurant.id, async (tx) =>
      ensureMenuDocument(tx, restaurant.id));
    const rows = await withTenant(restaurant.id, (tx) =>
      tx.select().from(chunks).where(eq(chunks.documentId, doc.id)));
    expect(rows).toHaveLength(0);
    expect(embedMock).not.toHaveBeenCalled(); // zero cards => embed must not be invoked at all
  });
});
