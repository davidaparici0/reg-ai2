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

import { GET as GET_ONE, PATCH, DELETE } from "@/app/api/modules/[id]/route";

const getOne = (cookie: string | null, id: string) =>
  GET_ONE(new Request(`http://x/api/modules/${id}`, { headers: cookie ? { cookie } : {} }),
    { params: Promise.resolve({ id }) });
const patch = (cookie: string | null, id: string, body: unknown) =>
  PATCH(new Request(`http://x/api/modules/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
const del = (cookie: string | null, id: string) =>
  DELETE(new Request(`http://x/api/modules/${id}`, { method: "DELETE", headers: cookie ? { cookie } : {} }),
    { params: Promise.resolve({ id }) });

describe("GET /api/modules/:id", () => {
  it("returns detail with the caller's progress; 404 for foreign/missing/non-uuid", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    const created = await (await post(a.cookie, { title: "Read me", content: { body: "deep" } })).json();
    const id = created.module.id;
    const got = await (await getOne(a.cookie, id)).json();
    expect(got.module.content.body).toBe("deep");
    expect(got.module.progress.status).toBe("not_started");
    expect((await getOne(b.cookie, id)).status).toBe(404);
    expect((await getOne(a.cookie, crypto.randomUUID())).status).toBe(404);
    expect((await getOne(a.cookie, "not-a-uuid")).status).toBe(404);
  });
});

describe("PATCH /api/modules/:id", () => {
  it("400 empty patch; 403 trainee; updates fields; reorders via position", async () => {
    const { cookie, restaurant } = await registerOwner();
    const created = await (await post(cookie, { title: "Old", content: { body: "b" }, position: 0 })).json();
    const id = created.module.id;
    expect((await patch(cookie, id, {})).status).toBe(400);
    const trainee = await makeUserCookie(restaurant.id, "trainee");
    expect((await patch(trainee.cookie, id, { title: "X" })).status).toBe(403);
    const updated = await (await patch(cookie, id, { title: "New", description: "d", position: 7 })).json();
    expect(updated.module.title).toBe("New");
    expect(updated.module.description).toBe("d");
    expect(updated.module.position).toBe(7);
    // explicit null clears description
    const cleared = await (await patch(cookie, id, { description: null })).json();
    expect(cleared.module.description).toBeNull();
  });

  it("400 when a content patch references an unresolvable id; 404 foreign", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    const created = await (await post(a.cookie, { title: "T", content: { body: "b" } })).json();
    expect((await patch(a.cookie, created.module.id, { content: { body: "b", menuItemIds: [crypto.randomUUID()] } })).status).toBe(400);
    expect((await patch(b.cookie, created.module.id, { title: "Steal" })).status).toBe(404);
  });
});

describe("DELETE /api/modules/:id", () => {
  it("403 trainee; 204 owner; cascades; foreign 404", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    const created = await (await post(a.cookie, { title: "T", content: { body: "b" } })).json();
    const id = created.module.id;
    const trainee = await makeUserCookie(a.restaurant.id, "trainee");
    expect((await del(trainee.cookie, id)).status).toBe(403);
    expect((await del(b.cookie, id)).status).toBe(404);
    expect((await del(a.cookie, id)).status).toBe(204);
    expect((await getOne(a.cookie, id)).status).toBe(404);
  });
});
