import { afterEach, describe, expect, it } from "vitest";
import { db, withTenant } from "@/lib/db";
import { restaurants, users, documents, menuItems } from "@/db/schema";
import { assertRefsResolveInTenant } from "@/lib/modules/refs";
import { normalizeProgress, toSummary, toDetail } from "@/lib/modules/serialize";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

async function seedTenant() {
  const [r] = await db.insert(restaurants).values({ name: "RefT" }).returning();
  track(r.id);
  await db.insert(users).values({
    restaurantId: r.id, email: `${crypto.randomUUID()}@t.test`, passwordHash: "x", role: "owner",
  });
  return r;
}

describe("assertRefsResolveInTenant", () => {
  it("true for empty/absent arrays", async () => {
    const r = await seedTenant();
    const ok = await withTenant(r.id, (tx) => assertRefsResolveInTenant(tx, undefined, []));
    expect(ok).toBe(true);
  });
  it("true when ids resolve in tenant, false for a foreign/unknown id", async () => {
    const r = await seedTenant();
    const [doc] = await withTenant(r.id, (tx) => tx.insert(documents).values({
      restaurantId: r.id, title: "SOP", sourceType: "text", contentHash: crypto.randomUUID(), status: "done",
    }).returning());
    const [mi] = await withTenant(r.id, (tx) => tx.insert(menuItems).values({
      restaurantId: r.id, name: "Soup",
    }).returning());
    const ok = await withTenant(r.id, (tx) => assertRefsResolveInTenant(tx, [doc.id], [mi.id]));
    expect(ok).toBe(true);
    const bad = await withTenant(r.id, (tx) => assertRefsResolveInTenant(tx, [crypto.randomUUID()], undefined));
    expect(bad).toBe(false);
  });
});

describe("serialize", () => {
  const row = {
    id: "m1", title: "T", description: null, position: 2,
    content: { body: "B", documentIds: ["d1", "d2"] },
    createdAt: new Date("2026-06-14T00:00:00Z"), updatedAt: new Date("2026-06-14T00:00:00Z"),
    restaurantId: "r1",
  } as never;

  it("normalizeProgress defaults a missing row to not_started", () => {
    expect(normalizeProgress(null)).toEqual({ status: "not_started", startedAt: null, completedAt: null });
    expect(normalizeProgress({ status: "completed", startedAt: new Date("2026-06-14T00:00:00Z"), completedAt: new Date("2026-06-14T00:00:00Z") }))
      .toEqual({ status: "completed", startedAt: "2026-06-14T00:00:00.000Z", completedAt: "2026-06-14T00:00:00.000Z" });
  });
  it("toSummary derives refCounts and omits body; toDetail adds content", () => {
    const s = toSummary(row, normalizeProgress(null));
    expect(s.refCounts).toEqual({ documents: 2, menuItems: 0 });
    expect("content" in s).toBe(false);
    const d = toDetail(row, normalizeProgress(null));
    expect(d.content).toEqual({ body: "B", documentIds: ["d1", "d2"], menuItemIds: [] });
  });
});
