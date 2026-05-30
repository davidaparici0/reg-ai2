import { afterEach, describe, expect, it } from "vitest";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as me } from "@/app/api/auth/me/route";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

const J = { "content-type": "application/json" };

describe("auth lifecycle", () => {
  it("register -> me -> logout -> me(401), and login again", async () => {
    const email = `${crypto.randomUUID()}@t.test`;
    const password = "x".repeat(12);

    const reg = await register(new Request("http://x/", { method: "POST", headers: J, body: JSON.stringify({ restaurantName: "Cycle", email, password }) }));
    track((await reg.json()).restaurant.id);
    const sid = reg.cookies.get("sid")!.value;

    expect((await me(new Request("http://x/", { headers: { cookie: `sid=${sid}` } }))).status).toBe(200);

    const out = await logout(new Request("http://x/", { method: "POST", headers: { cookie: `sid=${sid}` } }));
    expect(out.status).toBe(204);

    expect((await me(new Request("http://x/", { headers: { cookie: `sid=${sid}` } }))).status).toBe(401);

    const back = await login(new Request("http://x/", { method: "POST", headers: J, body: JSON.stringify({ email, password }) }));
    expect(back.status).toBe(200);
    expect(back.cookies.get("sid")?.value).toBeTruthy();
  });
});
