// Shared cursor parser for created_at-desc list endpoints. A cursor is an ISO timestamp.
// Returns {ok:false} for anything unparseable so the route can answer 400 instead of letting
// `new Date("garbage")` (Invalid Date) reach Postgres and 500.
export function parseDateCursor(raw: string | null): { ok: true; value: Date | null } | { ok: false } {
  if (raw == null) return { ok: true, value: null };
  if (raw === "") return { ok: false };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { ok: false };
  return { ok: true, value: d };
}
