// HTTP-facing rate-limit helpers. clientIp trusts x-forwarded-for — valid ONLY behind the
// Fly/Railway proxy; absent (local/dev/tests) => null => caller skips limiting (no self-block).
import type { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http/errors";
import { checkRateLimit } from "@/lib/ratelimit/limiter";

export function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return null;
  const first = xff.split(",")[0].trim();
  return first.length ? first : null;
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
