import { describe, expect, it } from "vitest";
import { RegisterReq, LoginReq, toPublicUser } from "@/lib/auth/types";

describe("auth types", () => {
  it("RegisterReq rejects short passwords and bad emails", () => {
    expect(RegisterReq.safeParse({ restaurantName: "R", email: "a@b.co", password: "short" }).success).toBe(false);
    expect(RegisterReq.safeParse({ restaurantName: "R", email: "nope", password: "x".repeat(12) }).success).toBe(false);
    expect(RegisterReq.safeParse({ restaurantName: "R", email: "a@b.co", password: "x".repeat(12) }).success).toBe(true);
  });

  it("LoginReq requires an email", () => {
    expect(LoginReq.safeParse({ email: "nope", password: "x" }).success).toBe(false);
  });

  it("toPublicUser strips passwordHash", () => {
    const row = {
      id: "u1", restaurantId: "r1", email: "a@b.co", passwordHash: "secret",
      role: "owner" as const, createdAt: new Date(), updatedAt: new Date(),
    };
    const pub = toPublicUser(row);
    expect("passwordHash" in pub).toBe(false);
    expect(pub.email).toBe("a@b.co");
  });
});
