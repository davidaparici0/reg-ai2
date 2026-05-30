import { afterEach, describe, expect, it } from "vitest";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { resolveSession } from "@/lib/auth/session";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

describe("POST /api/auth/logout", () => {
  it("revokes the session and clears the cookie (204)", async () => {
    const reg = await register(new Request("http://x/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ restaurantName: "LO", email: `${crypto.randomUUID()}@t.test`, password: "x".repeat(12) }),
    }));
    track((await reg.json()).restaurant.id);
    const token = reg.cookies.get("sid")!.value;

    const res = await logout(new Request("http://x/api/auth/logout", { method: "POST", headers: { cookie: `sid=${token}` } }));
    expect(res.status).toBe(204);
    expect(res.cookies.get("sid")?.value).toBe("");
    expect(await resolveSession(token)).toBeNull();
  });

  it("is idempotent with no cookie (204)", async () => {
    const res = await logout(new Request("http://x/api/auth/logout", { method: "POST" }));
    expect(res.status).toBe(204);
  });
});
