import { describe, expect, it } from "vitest";
import { errorResponse } from "@/lib/http/errors";

describe("errorResponse", () => {
  it("maps codes to statuses and wraps the envelope", async () => {
    const res = errorResponse("FORBIDDEN", "nope");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "FORBIDDEN", message: "nope" } });
  });

  it("includes details when provided", async () => {
    const res = errorResponse("VALIDATION_ERROR", "bad", { field: "email" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "VALIDATION_ERROR", message: "bad", details: { field: "email" } },
    });
  });
});
