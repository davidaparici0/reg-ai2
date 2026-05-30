import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as login } from "@/app/api/auth/login/route";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

let email: string;
const password = "x".repeat(12);

beforeEach(async () => {
  email = `${crypto.randomUUID()}@t.test`;
  const res = await register(new Request("http://x/", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ restaurantName: "L", email, password }),
  }));
  track((await res.json()).restaurant.id);
});

function loginReq(body: unknown) {
  return new Request("http://x/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("POST /api/auth/login", () => {
  it("logs in with correct credentials, sets cookie, 200", async () => {
    const res = await login(loginReq({ email, password }));
    expect(res.status).toBe(200);
    expect(res.cookies.get("sid")?.value).toBeTruthy();
    expect((await res.json()).user.email).toBe(email);
  });

  it("rejects wrong password with 401", async () => {
    const res = await login(loginReq({ email, password: "wrong-password" }));
    expect(res.status).toBe(401);
  });

  it("rejects unknown email with 401 and the same message (no enumeration)", async () => {
    const res = await login(loginReq({ email: `${crypto.randomUUID()}@t.test`, password }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toBe("Invalid email or password");
  });
});
