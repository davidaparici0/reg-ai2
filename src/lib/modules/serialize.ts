// Pure output shaping for /api/modules. ModuleSummary (list) omits the body; Module (detail)
// adds content. Progress is always normalized to a stable shape, never null.
import type { modules, moduleProgress } from "@/db/schema";

type ModuleRow = typeof modules.$inferSelect;
type ProgressRow = typeof moduleProgress.$inferSelect;

export type ProgressView = {
  status: "not_started" | "in_progress" | "completed";
  startedAt: string | null;
  completedAt: string | null;
};

export function normalizeProgress(
  p: Pick<ProgressRow, "status" | "startedAt" | "completedAt"> | null | undefined,
): ProgressView {
  return {
    status: p?.status ?? "not_started",
    startedAt: p?.startedAt ? p.startedAt.toISOString() : null,
    completedAt: p?.completedAt ? p.completedAt.toISOString() : null,
  };
}

export function toSummary(m: ModuleRow, progress: ProgressView) {
  return {
    id: m.id,
    title: m.title,
    description: m.description,
    position: m.position,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    refCounts: {
      documents: m.content.documentIds?.length ?? 0,
      menuItems: m.content.menuItemIds?.length ?? 0,
    },
    progress,
  };
}

export function toDetail(m: ModuleRow, progress: ProgressView) {
  return {
    ...toSummary(m, progress),
    content: {
      body: m.content.body,
      documentIds: m.content.documentIds ?? [],
      menuItemIds: m.content.menuItemIds ?? [],
    },
  };
}
