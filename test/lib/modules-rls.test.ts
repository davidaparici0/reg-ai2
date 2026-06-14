import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { restaurants, users, modules, moduleProgress } from "@/db/schema";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

async function seedModuleWithProgress(name: string) {
  const [r] = await db.insert(restaurants).values({ name }).returning();
  track(r.id);
  const [u] = await db.insert(users).values({
    restaurantId: r.id, email: `${crypto.randomUUID()}@t.test`, passwordHash: "x", role: "trainee",
  }).returning();
  return withTenant(r.id, async (tx) => {
    const [m] = await tx.insert(modules).values({
      restaurantId: r.id, title: `${name}-mod`, content: { body: "read me" }, position: 0,
    }).returning();
    const [p] = await tx.insert(moduleProgress).values({
      moduleId: m.id, userId: u.id, restaurantId: r.id, status: "completed",
    }).returning();
    return { restaurant: r, user: u, module: m, progress: p };
  });
}

describe("module_progress RLS + modules.position", () => {
  it("scopes progress reads to the GUC tenant", async () => {
    const a = await seedModuleWithProgress("MPA");
    const b = await seedModuleWithProgress("MPB");
    const aRows = await withTenant(a.restaurant.id, (tx) => tx.select().from(moduleProgress));
    expect(aRows.map((p) => p.id)).toEqual([a.progress.id]);
    const leak = await withTenant(a.restaurant.id, (tx) =>
      tx.select().from(moduleProgress).where(eq(moduleProgress.id, b.progress.id)));
    expect(leak).toHaveLength(0);
  });

  it("WITH CHECK blocks writing progress tagged for a different tenant", async () => {
    const a = await seedModuleWithProgress("MPC");
    const b = await seedModuleWithProgress("MPD");
    await expect(
      withTenant(a.restaurant.id, (tx) =>
        tx.insert(moduleProgress).values({
          moduleId: b.module.id, userId: b.user.id, restaurantId: b.restaurant.id, status: "completed",
        })),
    ).rejects.toThrow();
  });

  it("modules carry an integer position", async () => {
    const a = await seedModuleWithProgress("MPE");
    expect(a.module.position).toBe(0);
  });
});
