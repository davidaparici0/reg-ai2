// Single import surface for app code. Root schema.ts stays canonical (drizzle.config
// points at it); this lets modules write `@/db/schema` instead of `../../../schema`.
export * from "../../schema";
