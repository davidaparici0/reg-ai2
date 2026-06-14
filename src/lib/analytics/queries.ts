// Tenant-scoped analytics aggregates. Raw `sql` is used for the multi-aggregate GROUP BYs
// (clearer + one round-trip each than the query builder). Every query runs inside withTenant,
// so messages/message_sources/usage_events/conversations/module_progress/modules are RLS-scoped;
// `users` has NO RLS, so trainee queries filter restaurant_id explicitly (::uuid bind).
// `since` is a Date for a bounded window, or null for "all" (the IS NULL branch drops the filter).
import { sql } from "drizzle-orm";
import type { Tx } from "@/lib/db";

export type CostBucket = { model: string | null; calls: number; inputTokens: number; outputTokens: number; costUsd: string };
export type SummaryStats = {
  answered: number; grounded: number; traineesTotal: number; traineesActive: number;
  totalCostUsd: string; cost: { embedding: CostBucket; completion: CostBucket };
};
export type TraineeRow = { userId: string; email: string; questionsAsked: number; modulesCompleted: number; lastActiveAt: Date | null };
export type TraineeStats = { modulesTotal: number; rows: TraineeRow[] };

const ZERO_BUCKET: CostBucket = { model: null, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: "0.000000" };

function money(raw: unknown): string {
  return Number(raw ?? 0).toFixed(6);
}

export async function summaryStats(tx: Tx, rid: string, since: Date | null): Promise<SummaryStats> {
  // 1. answered + grounded (assistant messages; grounded = has >=1 message_sources row)
  const q = (await tx.execute(sql`
    SELECT
      count(*) FILTER (WHERE m.role = 'assistant')::int AS answered,
      count(*) FILTER (WHERE m.role = 'assistant'
        AND EXISTS (SELECT 1 FROM message_sources s WHERE s.message_id = m.id))::int AS grounded
    FROM messages m
    WHERE (${since}::timestamptz IS NULL OR m.created_at >= ${since})
  `)).rows[0] as { answered: number; grounded: number };

  // 2. cost by kind (+ model is the single distinct model for the kind, else null = mixed)
  const kinds = (await tx.execute(sql`
    SELECT kind,
      CASE WHEN count(DISTINCT model) = 1 THEN max(model) ELSE NULL END AS model,
      count(*)::int AS calls,
      COALESCE(sum(input_tokens), 0)::int AS input_tokens,
      COALESCE(sum(output_tokens), 0)::int AS output_tokens,
      COALESCE(sum(cost_usd), 0)::text AS cost_usd
    FROM usage_events
    WHERE (${since}::timestamptz IS NULL OR created_at >= ${since})
    GROUP BY kind
  `)).rows as Array<{ kind: "embedding" | "completion"; model: string | null; calls: number; input_tokens: number; output_tokens: number; cost_usd: string }>;

  const bucketFor = (kind: "embedding" | "completion"): CostBucket => {
    const row = kinds.find((k) => k.kind === kind);
    if (!row) return { ...ZERO_BUCKET };
    return { model: row.model, calls: row.calls, inputTokens: row.input_tokens, outputTokens: row.output_tokens, costUsd: money(row.cost_usd) };
  };

  // 3. total cost (all kinds), one SQL sum so money math stays in the DB
  const totalRow = (await tx.execute(sql`
    SELECT COALESCE(sum(cost_usd), 0)::text AS total
    FROM usage_events
    WHERE (${since}::timestamptz IS NULL OR created_at >= ${since})
  `)).rows[0] as { total: string };

  // 4. trainee roster size + active count (active = a question OR progress event in window)
  const tr = (await tx.execute(sql`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE active)::int AS active
    FROM (
      SELECT
        EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
                WHERE c.user_id = u.id AND m.role = 'user'
                  AND (${since}::timestamptz IS NULL OR m.created_at >= ${since}))
        OR EXISTS (SELECT 1 FROM module_progress mp WHERE mp.user_id = u.id
                  AND (${since}::timestamptz IS NULL OR mp.started_at >= ${since} OR mp.completed_at >= ${since})) AS active
      FROM users u
      WHERE u.restaurant_id = ${rid}::uuid AND u.role = 'trainee'
    ) z
  `)).rows[0] as { total: number; active: number };

  return {
    answered: q.answered, grounded: q.grounded,
    traineesTotal: tr.total, traineesActive: tr.active,
    totalCostUsd: money(totalRow.total),
    cost: { embedding: bucketFor("embedding"), completion: bucketFor("completion") },
  };
}

export async function traineeStats(tx: Tx, rid: string, since: Date | null): Promise<TraineeStats> {
  const total = (await tx.execute(sql`SELECT count(*)::int AS n FROM modules`)).rows[0] as { n: number };

  // questionsAsked = windowed user messages owned by the trainee (via conversations.user_id).
  // lastActiveAt   = cumulative max over {their user messages, their progress timestamps}.
  // modulesCompleted = cumulative count of status='completed'.
  // last_active_at is returned as epoch milliseconds (bigint) so the Date is built in JS —
  // node-postgres does not parse the GREATEST(timestamptz) result back into a Date.
  const rows = (await tx.execute(sql`
    SELECT
      u.id AS user_id, u.email AS email,
      COALESCE(q.questions_asked, 0)::int AS questions_asked,
      COALESCE(mp.modules_completed, 0)::int AS modules_completed,
      (extract(epoch FROM GREATEST(lm.last_msg, mp.last_progress)) * 1000)::bigint AS last_active_ms
    FROM users u
    LEFT JOIN (
      SELECT c.user_id, count(*)::int AS questions_asked
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.role = 'user' AND (${since}::timestamptz IS NULL OR m.created_at >= ${since})
      GROUP BY c.user_id
    ) q ON q.user_id = u.id
    LEFT JOIN (
      SELECT c.user_id, max(m.created_at) AS last_msg
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.role = 'user'
      GROUP BY c.user_id
    ) lm ON lm.user_id = u.id
    LEFT JOIN (
      SELECT user_id, count(*) FILTER (WHERE status = 'completed')::int AS modules_completed,
             max(GREATEST(started_at, completed_at)) AS last_progress
      FROM module_progress
      GROUP BY user_id
    ) mp ON mp.user_id = u.id
    WHERE u.restaurant_id = ${rid}::uuid AND u.role = 'trainee'
    ORDER BY COALESCE(q.questions_asked, 0) DESC, u.email ASC
  `)).rows as Array<{ user_id: string; email: string; questions_asked: number; modules_completed: number; last_active_ms: string | null }>;

  return {
    modulesTotal: total.n,
    rows: rows.map((r) => ({
      userId: r.user_id, email: r.email,
      questionsAsked: r.questions_asked, modulesCompleted: r.modules_completed,
      lastActiveAt: r.last_active_ms == null ? null : new Date(Number(r.last_active_ms)),
    })),
  };
}
