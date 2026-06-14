import { describe, expect, it } from "vitest";
import { CreateMenuItem, PatchMenuItem, priceToDb } from "@/lib/menu/validate";

describe("CreateMenuItem", () => {
  it("accepts a full valid item and lowercases dietary flags", () => {
    const r = CreateMenuItem.safeParse({
      name: "  Branzino ", description: "Whole sea bass", ingredients: ["branzino", "lemon"],
      allergens: ["fish"], dietaryFlags: ["Gluten_Free"], price: 42.5, active: true,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe("Branzino");          // trimmed
      expect(r.data.dietaryFlags).toEqual(["gluten_free"]); // lowercased transform
    }
  });

  it("requires name and applies defaults-by-absence for the rest", () => {
    const r = CreateMenuItem.safeParse({ name: "Soup" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.description).toBeUndefined(); // absent stays absent
    expect(CreateMenuItem.safeParse({}).success).toBe(false);
    expect(CreateMenuItem.safeParse({ name: "   " }).success).toBe(false); // whitespace-only name
  });

  it("rejects unknown keys (strict)", () => {
    expect(CreateMenuItem.safeParse({ name: "Soup", spicy: true }).success).toBe(false);
  });

  it("rejects allergens outside the DB vocabulary", () => {
    expect(CreateMenuItem.safeParse({ name: "Soup", allergens: ["gluten"] }).success).toBe(false);
  });

  it("rejects dietary flags that are not lowercase tokens after transform", () => {
    expect(CreateMenuItem.safeParse({ name: "Soup", dietaryFlags: ["has space"] }).success).toBe(false);
    expect(CreateMenuItem.safeParse({ name: "Soup", dietaryFlags: [""] }).success).toBe(false);
  });

  it("price: >=0, max 2 decimals", () => {
    expect(CreateMenuItem.safeParse({ name: "Soup", price: 12.5 }).success).toBe(true);
    expect(CreateMenuItem.safeParse({ name: "Soup", price: 12.555 }).success).toBe(false);
    expect(CreateMenuItem.safeParse({ name: "Soup", price: -1 }).success).toBe(false);
    expect(CreateMenuItem.safeParse({ name: "Soup", price: null }).success).toBe(true);  // nullable
    expect(CreateMenuItem.safeParse({ name: "Soup", price: 0 }).success).toBe(true);     // lower boundary
  });
});

describe("PatchMenuItem", () => {
  it("requires at least one field", () => {
    expect(PatchMenuItem.safeParse({}).success).toBe(false);
  });
  it("allows null to clear nullable fields, but not name", () => {
    expect(PatchMenuItem.safeParse({ description: null }).success).toBe(true);
    expect(PatchMenuItem.safeParse({ name: null }).success).toBe(false);
  });
  it("allows a lone active toggle", () => {
    expect(PatchMenuItem.safeParse({ active: false }).success).toBe(true);
  });
});

describe("priceToDb", () => {
  it("maps number to 2dp string, passes null/undefined through", () => {
    expect(priceToDb(12.5)).toBe("12.50");
    expect(priceToDb(null)).toBeNull();
    expect(priceToDb(undefined)).toBeUndefined();
    expect(priceToDb(0)).toBe("0.00");
  });
});
