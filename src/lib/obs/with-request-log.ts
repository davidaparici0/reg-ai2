import { logEvent } from "@/lib/obs/log";

// Wraps a Route Handler to emit one structured `http` log line per request, with its latency
// (FR-025 request logging + FR-027 per-request latency leg). Times with performance.now() and
// logs in a `finally`, so a handler that throws still records status 500 + durationMs before the
// error propagates. The route's own logic owns the response and what's sensitive — this observer
// only ever logs route/method/status/duration (never the body, question text, tokens, or DSN/key).
//
// The variadic rest generic preserves each handler's EXACT signature — `(req)` for static routes
// and `(req, ctx)` for dynamic ones — so Next's build-time route type validation still passes.
export function withRequestLog<A extends unknown[]>(
  route: string,
  handler: (req: Request, ...rest: A) => Promise<Response>,
): (req: Request, ...rest: A) => Promise<Response> {
  return async (req, ...rest) => {
    const start = performance.now();
    let status = 500;
    try {
      const res = await handler(req, ...rest);
      status = res.status;
      return res;
    } finally {
      logEvent("http", {
        route,
        method: req.method,
        status,
        durationMs: Math.round(performance.now() - start),
      });
    }
  };
}
