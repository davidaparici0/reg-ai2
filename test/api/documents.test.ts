import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { documents, documentBlobs } from "@/db/schema";
import { POST, GET } from "@/app/api/documents/route";
import { registerOwner, makeUserCookie } from "../helpers/auth";
import { cleanup } from "../helpers/db";
import { makeMinimalPdf } from "../helpers/pdf";

afterEach(cleanup);

function uploadReq(cookie: string, bytes: Buffer, opts: { title?: string; type?: string; name?: string } = {}) {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(bytes)], opts.name ?? "menu.pdf", { type: opts.type ?? "application/pdf" }));
  if (opts.title) fd.append("title", opts.title);
  return new Request("http://x/api/documents", { method: "POST", headers: { cookie }, body: fd });
}

describe("POST /api/documents", () => {
  it("accepts a PDF from a manager-or-above and returns 202 pending + a blob row", async () => {
    const owner = await registerOwner();
    const res = await POST(uploadReq(owner.cookie, makeMinimalPdf("upload test")));
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.status).toBe("pending");

    const blobs = await withTenant(owner.restaurant.id, (tx) =>
      tx.select().from(documentBlobs).where(eq(documentBlobs.documentId, json.documentId)));
    expect(blobs).toHaveLength(1);
  });

  it("is idempotent: a byte-identical re-upload returns 200 with the same id, no duplicate row", async () => {
    const owner = await registerOwner();
    const bytes = makeMinimalPdf("dedup me");
    const first = await POST(uploadReq(owner.cookie, bytes));
    const a = await first.json();
    const second = await POST(uploadReq(owner.cookie, bytes));
    expect(second.status).toBe(200);
    const b = await second.json();
    expect(b.documentId).toBe(a.documentId);

    const docs = await withTenant(owner.restaurant.id, (tx) => tx.select().from(documents));
    expect(docs).toHaveLength(1);
  });

  it("rejects a trainee with 403", async () => {
    const owner = await registerOwner();
    const trainee = await makeUserCookie(owner.restaurant.id, "trainee");
    const res = await POST(uploadReq(trainee.cookie, makeMinimalPdf("nope")));
    expect(res.status).toBe(403);
  });

  it("rejects a non-PDF with 400", async () => {
    const owner = await registerOwner();
    const res = await POST(uploadReq(owner.cookie, Buffer.from("hi"), { type: "text/plain", name: "x.txt" }));
    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await POST(uploadReq("sid=bogus", makeMinimalPdf("x")));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/documents", () => {
  it("lists this tenant's documents (chunkCount null while pending)", async () => {
    const owner = await registerOwner();
    await POST(uploadReq(owner.cookie, makeMinimalPdf("list me")));
    const res = await GET(new Request("http://x/api/documents", { headers: { cookie: owner.cookie } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toHaveLength(1);
    expect(json.items[0].status).toBe("pending");
    expect(json.items[0].chunkCount).toBeNull();
  });
});
