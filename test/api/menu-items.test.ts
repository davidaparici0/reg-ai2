import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { embedMock } = vi.hoisted(() => ({ embedMock: vi.fn() }));
vi.mock("@/lib/ai/embeddings", () => ({
  embed: embedMock, embeddingCostUsd: (t: number) => t * 1e-8,
  EMBEDDING_MODEL: "text-embedding-3-small", EMBEDDING_DIM: 1536,
}));

import { eq, and, asc } from "drizzle-orm";
import { POST, GET } from "@/app/api/menu-items/route";
import { withTenant } from "@/lib/db";
import { documents, chunks, menuItems } from "@/db/schema";
import { menuDocContentHash } from "@/lib/menu/rebuild";
import { registerOwner, makeUserCookie } from "../helpers/auth";
import { cleanup } from "../helpers/db";

afterEach(cleanup);
beforeEach(() => {
  embedMock.mockReset();
  embedMock.mockImplementation(async (texts: string[]) => ({
    vectors: texts.map((_, i) => { const v = Array(1536).fill(0); v[i] = 1; return v; }),
    usageTokens: texts.length * 10,
  }));
});

const post = (cookie: string | null, body: unknown) =>
  POST(new Request("http://x/api/menu-items", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }));
const list = (cookie: string | null, qs = "") =>
  GET(new Request(`http://x/api/menu-items${qs}`, { headers: cookie ? { cookie } : {} }));

async function menuChunks(rid: string) {
  return withTenant(rid, async (tx) => {
    const [doc] = await tx.select({ id: documents.id }).from(documents)
      .where(and(eq(documents.restaurantId, rid), eq(documents.contentHash, menuDocContentHash(rid))))
      .limit(1);
    if (!doc) return [];
    return tx.select().from(chunks).where(eq(chunks.documentId, doc.id)).orderBy(asc(chunks.chunkIndex));
  });
}

describe("POST /api/menu-items", () => {
  it("401 without a session; 403 for trainee; trainee GET is allowed", async () => {
    expect((await post(null, { name: "Soup" })).status).toBe(401);
    const { cookie, restaurant } = await registerOwner();
    const trainee = await makeUserCookie(restaurant.id, "trainee");
    expect((await post(trainee.cookie, { name: "Soup" })).status).toBe(403);
    expect((await list(trainee.cookie)).status).toBe(200);
    void cookie;
  });

  it("400 on invalid bodies", async () => {
    const { cookie } = await registerOwner();
    expect((await post(cookie, { name: "" })).status).toBe(400);
    expect((await post(cookie, { name: "Soup", allergens: ["gluten"] })).status).toBe(400);
    expect((await post(cookie, { name: "Soup", unknown: 1 })).status).toBe(400);
  });

  it("201 creates the item AND its menu card chunk immediately (FR-017)", async () => {
    const { cookie, restaurant } = await registerOwner();
    const res = await post(cookie, {
      name: "Seared Scallops", ingredients: ["scallops", "butter"],
      allergens: ["shellfish", "milk"], price: 36,
    });
    expect(res.status).toBe(201);
    const { menuItem } = await res.json();
    expect(menuItem.name).toBe("Seared Scallops");
    expect(menuItem.price).toBe("36.00"); // numeric -> string

    const rows = await menuChunks(restaurant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain("Dish: Seared Scallops.");
    expect(rows[0].text).toContain("shellfish, milk");
  });

  it("second create keeps cards name-ordered with contiguous indexes", async () => {
    const { cookie, restaurant } = await registerOwner();
    await post(cookie, { name: "Zucchini Tart" });
    await post(cookie, { name: "Apple Salad" });
    const rows = await menuChunks(restaurant.id);
    expect(rows.map((r) => r.chunkIndex)).toEqual([0, 1]);
    expect(rows[0].text.startsWith("Dish: Apple Salad.")).toBe(true);
  });

  it("ATOMIC: embed failure rolls back the row write and keeps old chunks (502)", async () => {
    const { cookie, restaurant } = await registerOwner();
    await post(cookie, { name: "Keeper" });                  // healthy first write
    embedMock.mockRejectedValueOnce(new Error("openai down"));
    const res = await post(cookie, { name: "Doomed" });
    expect(res.status).toBe(502);

    const items = await withTenant(restaurant.id, (tx) => tx.select().from(menuItems));
    expect(items.map((i) => i.name)).toEqual(["Keeper"]);    // Doomed row rolled back
    const rows = await menuChunks(restaurant.id);
    expect(rows).toHaveLength(1);                            // old chunk set intact
    expect(rows[0].text).toContain("Dish: Keeper.");
  });
});

describe("GET /api/menu-items", () => {
  it("lists own items only (isolation), newest-first, includes inactive", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    await post(a.cookie, { name: "A dish", active: false });
    const resB = await list(b.cookie);
    expect((await resB.json()).items).toHaveLength(0);
    const resA = await list(a.cookie);
    const bodyA = await resA.json();
    expect(bodyA.items).toHaveLength(1);
    expect(bodyA.items[0].active).toBe(false);               // inactive listed for managers
    expect(bodyA.nextCursor).toBeNull();
  });
});
