// Pure shaping of query results into the API JSON. All money is a 6dp string (matches
// numeric(12,6) storage); groundingRate is a [0,1] ratio (4dp) or null; perAnswerUsd is
// null when there were no answers. No DB access here — trivially unit-testable.
import type { Window } from "@/lib/analytics/window";
import type { SummaryStats, TraineeStats, CostBucket } from "@/lib/analytics/queries";

export type Range = { since: string | null; until: string };

export function serializeRange(since: Date | null, until: Date): Range {
  return { since: since ? since.toISOString() : null, until: until.toISOString() };
}

function bucket(b: CostBucket) {
  return { model: b.model, calls: b.calls, inputTokens: b.inputTokens, outputTokens: b.outputTokens, costUsd: b.costUsd };
}

export function toSummaryResponse(window: Window, range: Range, s: SummaryStats) {
  const total = Number(s.totalCostUsd);
  return {
    window, range,
    questions: {
      answered: s.answered,
      grounded: s.grounded,
      fallback: s.answered - s.grounded,
      groundingRate: s.answered > 0 ? Number((s.grounded / s.answered).toFixed(4)) : null,
    },
    trainees: { total: s.traineesTotal, active: s.traineesActive },
    cost: {
      totalUsd: total.toFixed(6),
      perAnswerUsd: s.answered > 0 ? (total / s.answered).toFixed(6) : null,
      byKind: { embedding: bucket(s.cost.embedding), completion: bucket(s.cost.completion) },
    },
  };
}

export function toTraineesResponse(window: Window, range: Range, t: TraineeStats) {
  return {
    window, range,
    trainees: t.rows.map((r) => ({
      user: { id: r.userId, email: r.email },
      questionsAsked: r.questionsAsked,
      modulesCompleted: r.modulesCompleted,
      modulesTotal: t.modulesTotal,
      lastActiveAt: r.lastActiveAt ? r.lastActiveAt.toISOString() : null,
    })),
  };
}
