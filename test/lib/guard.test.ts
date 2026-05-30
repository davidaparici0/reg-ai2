import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { restaurants, users } from "@/db/schema";
import { createSession } from "@/lib/auth/session";
import { readCookie, requireSession, hasRole } from "@/lib/auth/guard";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

describe("guard", () => {
  it("readCookie parses the named cookie", () => {
    const req = new Request("http://x/", { headers: { cookie: "a=1; sid=tok123; b=2" } });
    expect(readCookie(req, "sid")).toBe("tok123");
    expect(readCookie(new Request("http://x/"), "sid")).toBeNull();
  });

  it("hasRole respects the rank owner>=manager>=trainee", () => {
    expect(hasRole("owner", "manager")).toBe(true);
    expect(hasRole("trainee", "manager")).toBe(false);
    expect(hasRole("manager", "manager")).toBe(true);
  });

  it("requireSession returns the session for a valid sid cookie, null otherwise", async () => {
    const [r] = await db.insert(restaurants).values({ name: "G" }).returning();
    track(r.id);
    const [u] = await db.insert(users).values({
      restaurantId: r.id, email: `${crypto.randomUUID()}@t.test`, passwordHash: "x", role: "manager",
    }).returning();
    const { token } = await createSession(u.id);

    const ok = await requireSession(new Request("http://x/", { headers: { cookie: `sid=${token}` } }));
    expect(ok?.user.id).toBe(u.id);
    expect(await requireSession(new Request("http://x/"))).toBeNull();
  });
});
