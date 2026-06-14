// Request validation for /api/menu-items (Phase 4 spec §5). One base object; POST and
// PATCH derive from it so field rules can't drift. allergens reuses the DB enum values
// (schema.ts) — the controlled vocabulary IS the contract (a free-text allergen is a
// wrong safety answer waiting to happen).
import { z } from "zod";
import { allergen } from "@/db/schema";

// Lowercase+trim is a TRANSFORM (we normalize), the regex then VALIDATES the result.
const dietaryFlag = z.string().trim().toLowerCase()
  .pipe(z.string().regex(/^[a-z0-9_]{1,32}$/, "lowercase letters, digits, underscore (1-32 chars)"));

// String(p) renders plain decimal notation for any realistic price, so the regex is a
// reliable "max 2 decimals" check without float-modulo pitfalls (0.07 % 0.01 !== 0).
const price = z.number().min(0).max(100_000)
  .refine((p) => /^\d+(\.\d{1,2})?$/.test(String(p)), "at most 2 decimal places");

const base = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable(),
  ingredients: z.array(z.string().trim().min(1).max(100)).max(100).nullable(),
  allergens: z.array(z.enum(allergen.enumValues)).max(20).nullable(),
  dietaryFlags: z.array(dietaryFlag).max(20).nullable(),
  price: price.nullable(),
  active: z.boolean(),
});

// POST: name required; everything else optional (absent => DB default / null).
export const CreateMenuItem = base.partial().required({ name: true }).strict();
// PATCH: any subset, at least one key; name stays non-nullable.
export const PatchMenuItem = base.partial().strict()
  .refine((o) => Object.keys(o).length > 0, { message: "At least one field is required" });

export type CreateMenuItemInput = z.infer<typeof CreateMenuItem>;
export type PatchMenuItemInput = z.infer<typeof PatchMenuItem>;

// drizzle numeric columns take strings; keep absent (undefined) vs clear (null) distinct.
export const priceToDb = (p: number | null | undefined): string | null | undefined =>
  p == null ? p : p.toFixed(2);
