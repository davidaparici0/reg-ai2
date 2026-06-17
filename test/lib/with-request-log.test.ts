import { afterEach, describe, expect, it, vi } from "vitest";
import { withRequestLog } from "@/lib/obs/with-request-log";

afterEach(() => vi.restoreAllMocks());

const req = (method = "GET") => new Request("http://x/api/thing", { method });
const lastLine = (spy: ReturnType<typeof vi.spyOn>) =>
  JSON.parse(spy.mock.calls.at(-1)![0] as string);

describe("withRequestLog", () => {
  it("logs method/route/status/durationMs and returns the handler's response", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const handler = vi.fn(async () => new Response("ok", { status: 201 }));

    const res = await withRequestLog("things", handler)(req("POST"));

    expect(res.status).toBe(201);
    expect(handler).toHaveBeenCalledOnce();
    const line = lastLine(spy);
    expect(line.event).toBe("http");
    expect(line.route).toBe("things");
    expect(line.method).toBe("POST");
    expect(line.status).toBe(201);
    expect(typeof line.durationMs).toBe("number");
    expect(line.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("logs status 500 and re-throws when the handler throws", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const boom = new Error("boom");

    await expect(withRequestLog("things", async () => { throw boom; })(req())).rejects.toBe(boom);

    const line = lastLine(spy);
    expect(line.status).toBe(500);
    expect(line.route).toBe("things");
  });

  it("passes the route context (dynamic params) through to the handler", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = { params: Promise.resolve({ id: "abc" }) };
    const handler = vi.fn(async (_req: Request, _ctx: typeof ctx) => new Response(null, { status: 200 }));

    await withRequestLog("things/:id", handler)(req(), ctx);

    expect(handler).toHaveBeenCalledWith(expect.any(Request), ctx);
  });
});
