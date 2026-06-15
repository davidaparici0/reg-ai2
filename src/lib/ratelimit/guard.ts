// HTTP-facing rate-limit helpers. clientIp derives the caller IP from proxy headers — valid
// ONLY behind a single trusted reverse proxy (Fly/Railway); absent (local/dev/tests) => null
// => caller skips limiting (no self-block).
import type { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http/errors";
import { checkRateLimit } from "@/lib/ratelimit/limiter";

export function clientIp(req: Request): string | null {
  // Fly sets Fly-Client-IP to the true peer address, overwriting any client-supplied value —
  // trust it directly when present.
  const fly = req.headers.get("fly-client-ip")?.trim();
  if (fly) return fly;
  // Otherwise fall back to X-Forwarded-For. Our trusted edge APPENDS the real client IP to the
  // RIGHT; the LEFTMOST token is whatever the client sent (spoofable — trusting it lets an
  // attacker bypass the limit with forged IPs OR pre-exhaust a victim's bucket). So trust the
  // RIGHTMOST hop, the address our proxy actually observed. (Assumes one trusted proxy; if a
  // future deploy adds more hops, trust the Nth-from-right instead.)
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return null;
  const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : null;
}

export function tooManyRequests(retryAfter: number): NextResponse {
  const res = errorResponse("RATE_LIMITED", "Too many requests — please slow down");
  res.headers.set("Retry-After", String(Math.max(1, retryAfter)));
  return res;
}

// Returns a 429 response if the bucket is now over the limit, else null (proceed).
export async function enforceLimit(key: string, limit: number, windowSeconds: number): Promise<NextResponse | null> {
  const rl = await checkRateLimit(key, limit, windowSeconds);
  return rl.ok ? null : tooManyRequests(rl.retryAfter);
}
