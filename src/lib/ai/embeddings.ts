// The single, swappable embedding boundary. server-only: the OpenAI key never reaches
// client code and is never logged. Model + dim are LOCKED (rag.md §2) — changing them is
// a migration, not a flag.
import "server-only";
import OpenAI from "openai";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIM = 1536; // matches vector(1536) in schema
const COST_PER_TOKEN_USD = 0.02 / 1_000_000; // text-embedding-3-small: $0.02 / 1M tokens

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set (server-only).");
  client = new OpenAI({ apiKey });
  return client;
}

export function embeddingCostUsd(tokens: number): number {
  return tokens * COST_PER_TOKEN_USD;
}

export async function embed(texts: string[]): Promise<{ vectors: number[][]; usageTokens: number }> {
  if (texts.length === 0) return { vectors: [], usageTokens: 0 };
  // MVP: one batch. OpenAI allows up to 2048 inputs per call, and a single document's
  // chunks are well under that. If ingestion ever fans out to large corpora, add chunked
  // batching here. The guard turns a pathological input into a clear error, not a 400.
  if (texts.length > 2048) throw new Error(`embed: too many inputs (${texts.length} > 2048); batch upstream`);
  const res = await getClient().embeddings.create({ model: EMBEDDING_MODEL, input: texts });
  // OpenAI returns `data` sorted by `index`, but the SDK type doesn't guarantee order;
  // sort explicitly so vectors[i] always corresponds to texts[i].
  const sorted = res.data.slice().sort((a, b) => a.index - b.index);
  return { vectors: sorted.map((d) => d.embedding), usageTokens: res.usage.total_tokens };
}
