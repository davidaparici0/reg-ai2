import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

// FR-024: the liveness gate must confirm the DB is reachable AND pgvector is installed.
describe("GET /api/health", () => {
  it("returns 200 with db ok and the pgvector version", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.db).toBe("ok");
    expect(typeof body.vector).toBe("string");   // e.g. "0.8.2"
    expect(body.vector.length).toBeGreaterThan(0);
  });
});
