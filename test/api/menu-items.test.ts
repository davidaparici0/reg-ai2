import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { embedMock } = vi.hoisted(() => ({ embedMock: vi.fn() }));
vi.mock("@/lib/ai/embeddings", () => ({
  embed: embedMock, embeddingCostUsd: (t: number) => t * 1e-8,
  EMBEDDING_MODEL: "text-embedding-3-small", EMBEDDING_DIM: 1536,
}));

import { eq, and, asc } from "drizzle-orm";
import { POST, GET } from "@/app/api/menu-items/route";
import { PATCH, DELETE } from "@/app/api/menu-items/[id]/route";
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
    expect((await list(null)).status).toBe(401);             // no session
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

const patch = (cookie: string | null, id: string, body: unknown) =>
  PATCH(new Request(`http://x/api/menu-items/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
const del = (cookie: string | null, id: string) =>
  DELETE(new Request(`http://x/api/menu-items/${id}`, {
    method: "DELETE", headers: cookie ? { cookie } : {},
  }), { params: Promise.resolve({ id }) });

describe("PATCH /api/menu-items/:id", () => {
  it("400 on an empty patch; 403 for trainee", async () => {
    const { cookie, restaurant } = await registerOwner();
    const created = await (await post(cookie, { name: "Soup" })).json();
    expect((await patch(cookie, created.menuItem.id, {})).status).toBe(400);
    const trainee = await makeUserCookie(restaurant.id, "trainee");
    expect((await patch(trainee.cookie, created.menuItem.id, { name: "X" })).status).toBe(403);
  });

  it("updates fields and swaps the card immediately (FR-017 demo path)", async () => {
    const { cookie, restaurant } = await registerOwner();
    const created = await (await post(cookie, { name: "Grilled Chicken", allergens: null })).json();
    const res = await patch(cookie, created.menuItem.id, { allergens: ["sesame"] });
    expect(res.status).toBe(200);
    const rows = await menuChunks(restaurant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain("Allergens (recorded): sesame.");
    // Clearing back to null re-renders the safe empty wording (menuCard null-array guard).
    expect((await patch(cookie, created.menuItem.id, { allergens: null })).status).toBe(200);
    expect((await menuChunks(restaurant.id))[0].text).toContain("Allergens (recorded): none recorded.");
  });

  it("active=false removes the card; active=true restores it", async () => {
    const { cookie, restaurant } = await registerOwner();
    const created = await (await post(cookie, { name: "Soup" })).json();
    await patch(cookie, created.menuItem.id, { active: false });
    expect(await menuChunks(restaurant.id)).toHaveLength(0);
    await patch(cookie, created.menuItem.id, { active: true });
    expect(await menuChunks(restaurant.id)).toHaveLength(1);
  });

  it("404 for foreign-tenant, missing, and non-uuid ids (anti-enumeration)", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    const created = await (await post(a.cookie, { name: "Soup" })).json();
    expect((await patch(b.cookie, created.menuItem.id, { name: "Steal" })).status).toBe(404);
    expect((await patch(a.cookie, crypto.randomUUID(), { name: "X" })).status).toBe(404);
    expect((await patch(a.cookie, "not-a-uuid", { name: "X" })).status).toBe(404);
    // and the foreign write changed nothing:
    const rows = await menuChunks(a.restaurant.id);
    expect(rows[0].text).toContain("Dish: Soup.");
  });
});

describe("DELETE /api/menu-items/:id", () => {
  it("guards: 401 anonymous, 403 trainee, 404 non-uuid", async () => {
    const { cookie, restaurant } = await registerOwner();
    const created = await (await post(cookie, { name: "Soup" })).json();
    expect((await del(null, created.menuItem.id)).status).toBe(401);
    const trainee = await makeUserCookie(restaurant.id, "trainee");
    expect((await del(trainee.cookie, created.menuItem.id)).status).toBe(403);
    expect((await del(cookie, "not-a-uuid")).status).toBe(404);
  });

  it("204 deletes the row and its card; foreign id 404s", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    const created = await (await post(a.cookie, { name: "Soup" })).json();
    expect((await del(b.cookie, created.menuItem.id)).status).toBe(404);
    const res = await del(a.cookie, created.menuItem.id);
    expect(res.status).toBe(204);
    const items = await withTenant(a.restaurant.id, (tx) => tx.select().from(menuItems));
    expect(items).toHaveLength(0);
    expect(await menuChunks(a.restaurant.id)).toHaveLength(0);
  });
});

describe("GET /api/menu-items invalid cursor", () => {
  it("400 (not 500) on a malformed cursor", async () => {
    const { cookie } = await registerOwner();
    const res = await GET(new Request("http://x/api/menu-items?cursor=not-a-date", { headers: { cookie } }));
    expect(res.status).toBe(400);
  });
});
