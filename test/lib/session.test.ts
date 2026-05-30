import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { restaurants, users, sessions } from "@/db/schema";
import { createSession, resolveSession, revokeSession, hashToken } from "@/lib/auth/session";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

async function makeUser() {
  const [r] = await db.insert(restaurants).values({ name: "S" }).returning();
  track(r.id);
  const [u] = await db.insert(users).values({
    restaurantId: r.id, email: `${crypto.randomUUID()}@t.test`, passwordHash: "x", role: "owner",
  }).returning();
  return u;
}

describe("session", () => {
  it("create -> resolve round-trips and stores the hash, not the token", async () => {
    const u = await makeUser();
    const { token } = await createSession(u.id);
    const stored = await db.select().from(sessions).where(eq(sessions.id, hashToken(token)));
    expect(stored).toHaveLength(1);
    expect(stored[0].id).not.toBe(token);
    const resolved = await resolveSession(token);
    expect(resolved?.user.id).toBe(u.id);
    expect(resolved?.restaurant.id).toBe(u.restaurantId);
  });

  it("resolve returns null for an expired session and deletes it", async () => {
    const u = await makeUser();
    const { token } = await createSession(u.id);
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, hashToken(token)));
    expect(await resolveSession(token)).toBeNull();
    expect(await db.select().from(sessions).where(eq(sessions.id, hashToken(token)))).toHaveLength(0);
  });

  it("revoke removes the session", async () => {
    const u = await makeUser();
    const { token } = await createSession(u.id);
    await revokeSession(token);
    expect(await resolveSession(token)).toBeNull();
  });
});
