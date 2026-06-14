import { describe, expect, it } from "vitest";
import { parseWindow } from "@/lib/analytics/window";

const NOW = new Date("2026-06-14T00:00:00.000Z");
const sp = (qs: string) => new URLSearchParams(qs);
const DAY = 24 * 60 * 60 * 1000;

describe("parseWindow", () => {
  it("defaults to 30d when absent", () => {
    const w = parseWindow(sp(""), NOW)!;
    expect(w.window).toBe("30d");
    expect(w.until).toEqual(NOW);
    expect(w.since).toEqual(new Date(NOW.getTime() - 30 * DAY));
  });
  it("computes 7d and 90d offsets", () => {
    expect(parseWindow(sp("window=7d"), NOW)!.since).toEqual(new Date(NOW.getTime() - 7 * DAY));
    expect(parseWindow(sp("window=90d"), NOW)!.since).toEqual(new Date(NOW.getTime() - 90 * DAY));
  });
  it("maps 'all' to a null since (no lower bound)", () => {
    const w = parseWindow(sp("window=all"), NOW)!;
    expect(w.window).toBe("all");
    expect(w.since).toBeNull();
    expect(w.until).toEqual(NOW);
  });
  it("returns null for an invalid window value", () => {
    expect(parseWindow(sp("window=bogus"), NOW)).toBeNull();
    expect(parseWindow(sp("window=1y"), NOW)).toBeNull();
  });
});
