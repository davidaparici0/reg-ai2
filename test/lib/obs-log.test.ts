import { afterEach, describe, expect, it, vi } from "vitest";
import { logEvent } from "@/lib/obs/log";

afterEach(() => vi.restoreAllMocks());

describe("logEvent", () => {
  it("writes one JSON line with event + the given fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("http", { route: "ask", status: 200, durationMs: 12 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toEqual({
      event: "http", route: "ask", status: 200, durationMs: 12,
    });
  });

  it("logs ONLY what it is passed (no implicit/secret fields)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("http", { route: "ask" });
    expect(Object.keys(JSON.parse(spy.mock.calls[0][0] as string))).toEqual(["event", "route"]);
  });
});
