import { describe, expect, it } from "vitest";
import { parseDateCursor } from "@/lib/http/cursor";

describe("parseDateCursor", () => {
  it("absent/null => ok with null value", () => {
    expect(parseDateCursor(null)).toEqual({ ok: true, value: null });
  });
  it("a valid ISO date => ok with a Date", () => {
    const r = parseDateCursor("2026-06-14T00:00:00.000Z");
    expect(r.ok).toBe(true);
    expect(r.ok && r.value?.toISOString()).toBe("2026-06-14T00:00:00.000Z");
  });
  it("garbage => not ok", () => {
    expect(parseDateCursor("not-a-date")).toEqual({ ok: false });
    expect(parseDateCursor("")).toEqual({ ok: false });
  });
});
