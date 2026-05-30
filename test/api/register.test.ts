import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/auth/register/route";
import { track, cleanup } from "../helpers/db";

afterEach(cleanup);

function req(body: unknown) {
  return new Request("http://x/api/auth/register", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("POST /api/auth/register", () => {
  it("creates a restaurant + owner, sets a session cookie, returns 201", async () => {
    const email = `${crypto.randomUUID()}@t.test`;
    const res = await POST(req({ restaurantName: "Le Test", email, password: "x".repeat(12) }));
    expect(res.status).toBe(201);
    const json = await res.json();
    track(json.restaurant.id);
    expect(json.user.role).toBe("owner");
    expect(json.user.email).toBe(email);
    expect("passwordHash" in json.user).toBe(false);
    expect(res.cookies.get("sid")?.value).toBeTruthy();
  });

  it("rejects a duplicate email with 409", async () => {
    const email = `${crypto.randomUUID()}@t.test`;
    const first = await POST(req({ restaurantName: "A", email, password: "x".repeat(12) }));
    track((await first.json()).restaurant.id);
    const dup = await POST(req({ restaurantName: "B", email, password: "y".repeat(12) }));
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.code).toBe("CONFLICT");
  });

  it("rejects a bad body with 400", async () => {
    const res = await POST(req({ restaurantName: "", email: "nope", password: "short" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
});
