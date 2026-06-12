import { describe, expect, it } from "vitest";
import { menuCard, type MenuCardInput } from "@/lib/qa/menu-card";

const scallops: MenuCardInput = {
  name: "Seared Scallops",
  description: "Pan-seared, citrus beurre blanc",
  ingredients: ["scallops", "butter", "citrus"],
  allergens: ["shellfish"],   // note: NO milk recorded
  dietaryFlags: null,
  price: "38.00",
};

describe("menuCard()", () => {
  it("is deterministic", () => {
    expect(menuCard(scallops)).toBe(menuCard(scallops));
  });

  it("lists only recorded allergens and flags the unknown rest to the kitchen", () => {
    const card = menuCard(scallops);
    expect(card).toContain("Seared Scallops");
    expect(card).toContain("Allergens (recorded): shellfish");
    expect(card).toContain("confirm with the kitchen");
    // must NOT assert anything about dairy either way
    expect(card.toLowerCase()).not.toContain("dairy-free");
    expect(card.toLowerCase()).not.toContain("milk");
  });

  it("renders empty allergen/dietary as 'none recorded'", () => {
    const card = menuCard({ ...scallops, allergens: [], dietaryFlags: [] });
    expect(card).toContain("Allergens (recorded): none recorded");
    expect(card).toContain("Dietary: none recorded");
  });
});
