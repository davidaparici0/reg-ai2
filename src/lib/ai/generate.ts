// The single, swappable text-generation boundary. server-only: the OpenAI key never reaches
// client code and is never logged. Model is a one-line swap (rag.md §8 / Phase 3 spec §5.2).
import "server-only";
import OpenAI from "openai";

export const COMPLETION_MODEL = "gpt-4.1-mini";
// CONFIRM against current OpenAI pricing at build time (Phase 3 spec §11):
const COST_INPUT_PER_TOKEN = 0.40 / 1_000_000;  // ~$0.40 / 1M input tokens
const COST_OUTPUT_PER_TOKEN = 1.60 / 1_000_000; // ~$1.60 / 1M output tokens

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set (server-only).");
  client = new OpenAI({ apiKey });
  return client;
}

export function completionCostUsd(inTok: number, outTok: number): number {
  return inTok * COST_INPUT_PER_TOKEN + outTok * COST_OUTPUT_PER_TOKEN;
}

export async function generate(messages: ChatMessage[]): Promise<{
  text: string; inputTokens: number; outputTokens: number;
}> {
  // temperature 0: grounded Q&A wants determinism (and reproducible evals), not creativity.
  const res = await getClient().chat.completions.create({
    model: COMPLETION_MODEL, temperature: 0, messages,
  });
  const text = (res.choices[0]?.message?.content ?? "").trim();
  return {
    text,
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
  };
}
