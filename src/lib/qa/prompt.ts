// The grounding prompt (rag.md §5). The RULES are requirements; the WORDING is David's to
// finalize (// DAVID below). FALLBACK_TEXT is shared with answer.ts so "below threshold" and
// "model declined" produce identical user-facing text.
import type { ChatMessage } from "@/lib/ai/generate";
import type { RetrievedChunk } from "@/lib/qa/retrieve";

// DAVID: finalize this exact refusal string.
export const FALLBACK_TEXT =
  "I don't have that in this restaurant's materials — please check with your manager.";

export function buildPrompt(restaurantName: string, chunks: RetrievedChunk[], question: string): ChatMessage[] {
  const context = chunks.map((c, i) => `[${i + 1}] ${c.text}`).join("\n\n");
  // DAVID: finalize this wording. Keep the four rules (answer only from context; exact
  // FALLBACK_TEXT on a miss; allergen/food-safety caution; concise).
  const system =
    `You are a training assistant for ${restaurantName}. Answer ONLY using the numbered ` +
    `context below, which comes from this restaurant's own materials.\n\n` +
    `Rules:\n` +
    `- If the context does not contain the answer, reply EXACTLY: "${FALLBACK_TEXT}" ` +
    `Do not use outside knowledge. Do not guess.\n` +
    `- Cite the context you used by its [number].\n` +
    `- For allergen, dietary, or food-safety questions: state only what the context explicitly ` +
    `says. If it is incomplete or absent, say so and advise confirming with the kitchen or ` +
    `manager. Never call something "safe" beyond what the context supports.\n` +
    `- Be concise and practical — staff may be reading this mid-shift.\n\n` +
    `CONTEXT:\n${context}`;
  return [
    { role: "system", content: system },
    { role: "user", content: question },
  ];
}
