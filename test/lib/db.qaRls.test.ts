import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { restaurants, users, conversations, messages } from "@/db/schema";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

async function seedConversationWithMessage(name: string) {
  const [r] = await db.insert(restaurants).values({ name }).returning();
  track(r.id);
  const [u] = await db.insert(users).values({
    restaurantId: r.id, email: `${crypto.randomUUID()}@t.test`, passwordHash: "x", role: "owner",
  }).returning();
  return withTenant(r.id, async (tx) => {
    const [c] = await tx.insert(conversations).values({ restaurantId: r.id, userId: u.id }).returning();
    const [m] = await tx.insert(messages).values({
      conversationId: c.id, restaurantId: r.id, role: "user", content: `${name}-msg`,
    }).returning();
    return { restaurant: r, user: u, conversation: c, message: m };
  });
}

describe("Q&A tables + RLS", () => {
  it("scopes message reads to the GUC tenant", async () => {
    const a = await seedConversationWithMessage("QAA");
    const b = await seedConversationWithMessage("QAB");

    const aMsgs = await withTenant(a.restaurant.id, (tx) => tx.select().from(messages));
    expect(aMsgs.map((m) => m.id)).toEqual([a.message.id]);

    const leak = await withTenant(a.restaurant.id, (tx) =>
      tx.select().from(messages).where(eq(messages.id, b.message.id)));
    expect(leak).toHaveLength(0);
  });

  it("WITH CHECK blocks writing a message for a different tenant", async () => {
    const a = await seedConversationWithMessage("QAC");
    const b = await seedConversationWithMessage("QAD");
    // Under A's GUC, inserting a message tagged for B fails the policy's WITH CHECK.
    await expect(
      withTenant(a.restaurant.id, (tx) =>
        tx.insert(messages).values({
          conversationId: b.conversation.id, restaurantId: b.restaurant.id, role: "user", content: "evil",
        })),
    ).rejects.toThrow();
  });
});
