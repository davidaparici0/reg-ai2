import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, verifyDummy } from "@/lib/auth/password";

describe("password", () => {
  it("hashes (not plaintext) and verifies round-trip", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h).not.toBe("correct horse battery staple");
    expect(await verifyPassword(h, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(h, "wrong")).toBe(false);
  });

  it("verifyPassword returns false on a malformed hash instead of throwing", async () => {
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });

  it("verifyDummy resolves without throwing (timing equalizer)", async () => {
    await expect(verifyDummy("anything")).resolves.toBeUndefined();
  });
});
