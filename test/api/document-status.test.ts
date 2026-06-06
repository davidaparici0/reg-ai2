import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/documents/route";
import { GET } from "@/app/api/documents/[id]/route";
import { registerOwner, makeUserCookie } from "../helpers/auth";
import { cleanup } from "../helpers/db";
import { makeMinimalPdf } from "../helpers/pdf";

afterEach(cleanup);

function uploadReq(cookie: string, bytes: Buffer) {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(bytes)], "menu.pdf", { type: "application/pdf" }));
  return new Request("http://x/api/documents", { method: "POST", headers: { cookie }, body: fd });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/documents/:id", () => {
  it("returns status for this tenant's document", async () => {
    const owner = await registerOwner();
    const up = await (await POST(uploadReq(owner.cookie, makeMinimalPdf("status test")))).json();
    const res = await GET(new Request("http://x/api/documents/" + up.documentId, { headers: { cookie: owner.cookie } }), ctx(up.documentId));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe(up.documentId);
    expect(json.status).toBe("pending");
    expect(json.chunkCount).toBeNull();
  });

  it("404s a document that belongs to another tenant", async () => {
    const a = await registerOwner();
    const b = await registerOwner();
    const up = await (await POST(uploadReq(a.cookie, makeMinimalPdf("a-only")))).json();
    const res = await GET(new Request("http://x/api/documents/" + up.documentId, { headers: { cookie: b.cookie } }), ctx(up.documentId));
    expect(res.status).toBe(404);
  });

  it("404s a non-uuid / unknown id", async () => {
    const owner = await registerOwner();
    const res = await GET(new Request("http://x/api/documents/not-a-uuid", { headers: { cookie: owner.cookie } }), ctx("not-a-uuid"));
    expect(res.status).toBe(404);
  });

  it("403s a trainee", async () => {
    const owner = await registerOwner();
    const trainee = await makeUserCookie(owner.restaurant.id, "trainee");
    const res = await GET(new Request("http://x/api/documents/" + crypto.randomUUID(), { headers: { cookie: trainee.cookie } }), ctx(crypto.randomUUID()));
    expect(res.status).toBe(403);
  });
});
