import { afterEach, describe, expect, it } from "vitest";
import { POST, GET } from "@/app/api/modules/route";
import { registerOwner, makeUserCookie } from "../helpers/auth";
import { cleanup } from "../helpers/db";

afterEach(cleanup);

const post = (cookie: string | null, body: unknown) =>
  POST(new Request("http://x/api/modules", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }));
const list = (cookie: string | null, qs = "") =>
  GET(new Request(`http://x/api/modules${qs}`, { headers: cookie ? { cookie } : {} }));

describe("POST /api/modules", () => {
  it("401 anon; 403 trainee; 201 for manager", async () => {
    expect((await post(null, { title: "T", content: { body: "b" } })).status).toBe(401);
    const { restaurant } = await registerOwner();
    const trainee = await makeUserCookie(restaurant.id, "trainee");
    expect((await post(trainee.cookie, { title: "T", content: { body: "b" } })).status).toBe(403);
    const mgr = await makeUserCookie(restaurant.id, "manager");
    expect((await post(mgr.cookie, { title: "T", content: { body: "b" } })).status).toBe(201);
  });

  it("400 on invalid body and on unknown keys", async () => {
    const { cookie } = await registerOwner();
    expect((await post(cookie, { content: { body: "b" } })).status).toBe(400);
    expect((await post(cookie, { title: "T", content: { body: "b" }, nope: 1 })).status).toBe(400);
  });

  it("400 when a documentId/menuItemId does not resolve in the tenant", async () => {
    const { cookie } = await registerOwner();
    const res = await post(cookie, { title: "T", content: { body: "b", documentIds: [crypto.randomUUID()] } });
    expect(res.status).toBe(400);
  });

  it("appends position and returns detail with not_started progress", async () => {
    const { cookie } = await registerOwner();
    const first = await (await post(cookie, { title: "One", content: { body: "b" } })).json();
    const second = await (await post(cookie, { title: "Two", content: { body: "b" } })).json();
    expect(first.module.position).toBe(0);
    expect(second.module.position).toBe(1);
    expect(first.module.progress).toEqual({ status: "not_started", startedAt: null, completedAt: null });
    expect(first.module.content.body).toBe("b");
  });
});

describe("GET /api/modules", () => {
  it("401 anon; lists own modules in curriculum order; isolates tenants", async () => {
    expect((await list(null)).status).toBe(401);
    const a = await registerOwner();
    const b = await registerOwner();
    await post(a.cookie, { title: "A1", content: { body: "b" }, position: 5 });
    await post(a.cookie, { title: "A0", content: { body: "b" }, position: 1 });
    const bodyB = await (await list(b.cookie)).json();
    expect(bodyB.modules).toHaveLength(0);
    const bodyA = await (await list(a.cookie)).json();
    expect(bodyA.modules.map((m: { title: string }) => m.title)).toEqual(["A0", "A1"]); // position asc
    expect("content" in bodyA.modules[0]).toBe(false);                                   // summary omits body
    expect(bodyA.nextCursor).toBeNull();
  });

  it("400 on a malformed cursor", async () => {
    const { cookie } = await registerOwner();
    expect((await list(cookie, "?cursor=not-valid")).status).toBe(400);
  });
});
