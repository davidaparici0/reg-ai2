// Structured JSON logging for HTTP requests (FR-025). One line per event; the CALLER picks
// the fields, so secrets/PII are never logged unless explicitly passed (they aren't — we log
// route/method/status/duration/tenant, never the question text, tokens, or the DSN/key).
// Mirrors the worker's log shape (src/lib/ingest/process-document.ts).
export function logEvent(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}
