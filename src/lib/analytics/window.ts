// Parse the ?window= selector into a concrete [since, until] range. A bounded Zod enum
// (not free-form dates) => an invalid value is a clean 400, and there is no date parsing
// to 500 on. `now` is injected so the logic is deterministic in tests.
import { z } from "zod";

export const WindowParam = z.enum(["7d", "30d", "90d", "all"]).default("30d");
export type Window = z.infer<typeof WindowParam>;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS: Record<Exclude<Window, "all">, number> = { "7d": 7, "30d": 30, "90d": 90 };

export type WindowRange = { window: Window; since: Date | null; until: Date };

export function parseWindow(searchParams: URLSearchParams, now: Date): WindowRange | null {
  const parsed = WindowParam.safeParse(searchParams.get("window") ?? undefined);
  if (!parsed.success) return null;
  const window = parsed.data;
  if (window === "all") return { window, since: null, until: now };
  return { window, since: new Date(now.getTime() - DAYS[window] * DAY_MS), until: now };
}
