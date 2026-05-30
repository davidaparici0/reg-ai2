import { afterEach, describe, expect, it } from "vitest";
import { POST as register } from "@/app/api/auth/register/route";
import { GET as me } from "@/app/api/auth/me/route";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

describe("GET /api/auth/me", () => {
  it("returns the session user + restaurant (no passwordHash)", async () => {
    const email = `${crypto.randomUUID()}@t.test`;
    const reg = await register(new Request("http://x/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ restaurantName: "ME", email, password: "x".repeat(12) }),
    }));
    track((await reg.json()).restaurant.id);
    const token = reg.cookies.get("sid")!.value;

    const res = await me(new Request("http://x/api/auth/me", { headers: { cookie: `sid=${token}` } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.email).toBe(email);
    expect("passwordHash" in json.user).toBe(false);
    expect(json.restaurant.name).toBe("ME");
  });

  it("returns 401 without a session", async () => {
    const res = await me(new Request("http://x/api/auth/me"));
    expect(res.status).toBe(401);
  });
});
