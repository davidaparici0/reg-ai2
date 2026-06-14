// Request validation for /api/modules (Phase 5 spec §5). One base object; POST and PATCH
// derive from it so field rules can't drift. content is the firmed-up Phase 5 shape:
// authored body + optional tenant-scoped doc/menu references (resolution checked in refs.ts).
import { z } from "zod";

const uuid = z.string().uuid();

export const ModuleContent = z.object({
  body: z.string().trim().min(1).max(50_000),
  documentIds: z.array(uuid).max(50).optional(),
  menuItemIds: z.array(uuid).max(50).optional(),
}).strict();

const base = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable(),
  content: ModuleContent,
  position: z.number().int().min(0),
});

// POST: title + content required; description/position optional (absent => null / append).
export const CreateModule = base.partial().required({ title: true, content: true }).strict();
// PATCH: any subset, at least one key; a content patch replaces the whole object.
export const PatchModule = base.partial().strict()
  .refine((o) => Object.keys(o).length > 0, { message: "At least one field is required" });

// Trainee self-mark — not_started is the implicit default (absent row), so it's not accepted here.
export const ProgressUpdate = z.object({ status: z.enum(["in_progress", "completed"]) }).strict();

export type CreateModuleInput = z.infer<typeof CreateModule>;
export type PatchModuleInput = z.infer<typeof PatchModule>;
export type ModuleContentInput = z.infer<typeof ModuleContent>;
export type ProgressUpdateInput = z.infer<typeof ProgressUpdate>;
