// Deterministic text rendering of a menu item, embedded into `chunks` so menu questions
// flow through the SAME retrieval path as documents (Phase 3 spec §2). Safety: render only
// the RECORDED allergens; the closing note pushes unknowns to the kitchen (FR-014). Never
// claim an unlisted allergen is absent. Reused by Phase 4 menu CRUD.
export type MenuCardInput = {
  name: string;
  description: string | null;
  ingredients: string[] | null;
  allergens: string[] | null;
  dietaryFlags: string[] | null;
  price: string | null; // drizzle numeric -> string
};

const list = (xs: string[] | null, empty: string) => (xs && xs.length ? xs.join(", ") : empty);

export function menuCard(item: MenuCardInput): string {
  return [
    `Dish: ${item.name}.`,
    item.description ? `Description: ${item.description}.` : null,
    `Ingredients: ${list(item.ingredients, "not listed")}.`,
    `Allergens (recorded): ${list(item.allergens, "none recorded")}.`,
    `Dietary: ${list(item.dietaryFlags, "none recorded")}.`,
    item.price ? `Price: $${item.price}.` : null,
    `Note: allergens not listed above are not recorded in our data — confirm with the kitchen.`,
  ].filter(Boolean).join(" ");
}
