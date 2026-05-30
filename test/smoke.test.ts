import { describe, it, expect } from "vitest";

describe("harness", () => {
  it("runs and sees DATABASE_URL", () => {
    expect(process.env.DATABASE_URL).toBeTruthy();
  });
});
