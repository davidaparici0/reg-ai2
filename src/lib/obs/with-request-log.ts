import { logEvent } from "@/lib/obs/log";

// Wraps a Route Handler to emit one structured `http` log line per request, with its latency
// (FR-025 request logging + FR-027 per-request latency leg). Times with performance.now() and
// logs in a `finally`, so a handler that throws still records status 500 + durationMs before the
// error propagates. The route's own logic owns the response and what's sensitive — this observer
// only ever logs route/method/status/duration (never the body, question text, tokens, or DSN/key).
//
// Two generics keep BOTH call sites type-clean:
//   • `A` — the handler's trailing args (e.g. the `ctx: { params }` of a dynamic route, or `[]`
//     for a static one). The wrapped fn's first param is an OPTIONAL `Request` so it accepts a
//     zero-arg handler (`GET()`) called either as `GET()` or `GET(req)` — both real in our tests.
//   • `R` — the handler's CONCRETE response type (e.g. `NextResponse`, which carries `.cookies`).
//     Preserving it (instead of widening to `Response`) keeps the direct-call route unit tests,
//     which read `res.cookies`, type-clean. `R extends Response` lets us read `res.status` here.
// The wrapper reads the HTTP method off the passed Request when there is one (static/dynamic routes
// and the wrapper's own tests pass it); a `GET()` call with no Request logs method `undefined`.
export function withRequestLog<A extends unknown[], R extends Response>(
  route: string,
  handler: (req: Request, ...rest: A) => Promise<R>,
): (req?: Request, ...rest: A) => Promise<R> {
  return async (req?: Request, ...rest: A) => {
    const start = performance.now();
    let status = 500;
    try {
      const res = await handler(req as Request, ...rest);
      status = res.status;
      return res;
    } finally {
      logEvent("http", {
        route,
        method: req?.method,
        status,
        durationMs: Math.round(performance.now() - start),
      });
    }
  };
}
