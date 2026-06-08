// Calibration + verification over eval/eval-set.yaml. Reuses prod retrieve/buildPrompt/
// generate (no drift). Prints the distribution for threshold calibration (rag.md §4) and
// auto-checks fallbacks + isolation. Run: npm run eval:run
import "dotenv/config";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { eq } from "drizzle-orm";
import { db, withTenant, pool } from "@/lib/db";
import { restaurants, users } from "@/db/schema";
import { embed } from "@/lib/ai/embeddings";
import { retrieve } from "@/lib/qa/retrieve";
import { buildPrompt, FALLBACK_TEXT } from "@/lib/qa/prompt";
import { generate } from "@/lib/ai/generate";
import { answer, THRESHOLD } from "@/lib/qa/answer";
import { RESTAURANT_A, RESTAURANT_B } from "./content";

type EvalQ = {
  id: string; question: string; expects_fallback: boolean; safety_critical: boolean;
};

async function restaurantId(name: string): Promise<string> {
  const [r] = await db.select({ id: restaurants.id }).from(restaurants).where(eq(restaurants.name, name)).limit(1);
  if (!r) throw new Error(`${name} not seeded — run npm run eval:seed first`);
  return r.id;
}

async function main() {
  const set = parseYaml(readFileSync("eval/eval-set.yaml", "utf8")) as { questions: EvalQ[] };
  const ridA = await restaurantId(RESTAURANT_A);
  const ridB = await restaurantId(RESTAURANT_B);

  const rows: { id: string; fb: boolean; safety: boolean; top1: number; gate: boolean; topDoc: string; leak: boolean }[] = [];

  for (const q of set.questions) {
    const { vectors } = await embed([q.question]);
    const qEmb = vectors[0];

    const hitsA = await withTenant(ridA, (tx) => retrieve(tx, qEmb, 5));
    const top1 = hitsA[0]?.similarity ?? 0;
    const gate = top1 >= THRESHOLD;

    // Isolation: same question under B must share zero chunkIds with A's hits.
    const hitsB = await withTenant(ridB, (tx) => retrieve(tx, qEmb, 5));
    const aIds = new Set(hitsA.map((h) => h.chunkId));
    const leak = hitsB.some((h) => aIds.has(h.chunkId));

    rows.push({
      id: q.id, fb: q.expects_fallback, safety: q.safety_critical,
      top1: Number(top1.toFixed(4)), gate, topDoc: hitsA[0]?.documentTitle ?? "—", leak,
    });

    // Show the generated answer for human pass_condition scoring on answerable questions.
    if (gate && !q.expects_fallback) {
      const out = await generate(buildPrompt(RESTAURANT_A, hitsA, q.question));
      console.log(`\n[${q.id}] ${q.question}\n  top1=${top1.toFixed(3)} (${rows[rows.length - 1].topDoc})\n  ANSWER: ${out.text}`);
    }
  }

  // ---- Distribution + verdicts -------------------------------------------------
  console.log("\n=== distribution ===");
  for (const r of rows) {
    console.log(`${r.id}  fb=${r.fb ? "Y" : "n"} safety=${r.safety ? "Y" : "n"}  top1=${r.top1.toFixed(4)}  gate=${r.gate ? "PASS" : "decline"}  ${r.topDoc}`);
  }

  const answerable = rows.filter((r) => !r.fb);
  const fallbacks = rows.filter((r) => r.fb);
  const minAnswerable = Math.min(...answerable.map((r) => r.top1));
  const maxFallback = Math.max(...fallbacks.map((r) => r.top1));
  console.log(`\nanswerable min top1 = ${minAnswerable.toFixed(4)}; fallback max top1 = ${maxFallback.toFixed(4)}`);
  console.log(`suggested THRESHOLD ∈ (${maxFallback.toFixed(4)}, ${minAnswerable.toFixed(4)}] — bias UP near safety-critical lines`);

  // ---- Auto-asserts ------------------------------------------------------------
  const fallbackOk = fallbacks.every((r) => !r.gate);                 // all three decline at current THRESHOLD
  const answerableGateOk = answerable.every((r) => r.gate);           // all answerable clear it
  const noLeak = rows.every((r) => !r.leak);                          // zero cross-tenant leaks
  console.log(`\nfallbacks decline: ${fallbackOk ? "PASS" : "FAIL"}`);
  console.log(`answerable clear gate: ${answerableGateOk ? "PASS" : "FAIL"} (judge top-doc relevance by eye for ≥90%)`);
  console.log(`isolation (0 leaks): ${noLeak ? "PASS" : "FAIL"}`);

  // Also exercise the full persisted path once end-to-end (needs a real user for the FK).
  const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.restaurantId, ridA)).limit(1);
  const probe = await withTenant(ridA, (tx) => answer(tx, {
    restaurantId: ridA, userId: owner.id,
    restaurantName: RESTAURANT_A, question: "What's the guest WiFi password?",
  }));
  console.log(`\nend-to-end fallback probe (Q15-style): grounded=${probe.grounded} (expect false), answer="${probe.answer}"`);
  console.log(probe.answer === FALLBACK_TEXT ? "probe PASS" : "probe FAIL");

  await pool.end();
  if (!fallbackOk || !noLeak) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
