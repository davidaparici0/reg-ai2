// Deterministic chunker (FR-006). Pure function of (normalized text, fixed params):
// same text in -> identical chunks out. That determinism is what makes the raw-bytes
// content-hash dedup meaningful (re-ingesting the same file can't produce new chunks).
// Tunable against the eval set in Phase 3. Contract: test/lib/chunk.test.ts.
import { encode, decode } from "gpt-tokenizer/encoding/cl100k_base";

export const TARGET_TOKENS = 500;   // ~ a full dish description / SOP step with context
export const OVERLAP_TOKENS = 75;   // ~15% — carries context across a chunk boundary

export type Chunk = { text: string; tokenCount: number; chunkIndex: number };

// Deterministic normalization: \r\n -> \n, collapse intra-line whitespace, trim each
// line, collapse blank-line runs to a single blank line, trim the ends.
export function normalize(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .split("\n").map((l) => l.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Slice an already-encoded token array into overlapping windows of <= TARGET tokens
// (step = TARGET - OVERLAP, so consecutive windows share OVERLAP tokens). Used for a
// single paragraph that is itself larger than the target.
function tokenWindows(toks: number[]): string[] {
  const pieces: string[] = [];
  const step = TARGET_TOKENS - OVERLAP_TOKENS;
  for (let i = 0; i < toks.length; i += step) {
    pieces.push(decode(toks.slice(i, i + TARGET_TOKENS)));
    if (i + TARGET_TOKENS >= toks.length) break;
  }
  return pieces;
}

export function chunk(raw: string): Chunk[] {
  const text = normalize(raw);
  if (!text) return [];

  const chunks: Chunk[] = [];
  const add = (body: string) =>
    chunks.push({ text: body, tokenCount: encode(body).length, chunkIndex: chunks.length });

  let buf: string[] = [];
  let bufTokens = 0;
  const emit = () => {
    if (buf.length) { add(buf.join("\n\n")); buf = []; bufTokens = 0; }
  };

  // Natural boundaries first: paragraphs (blank-line separated). Encode each once.
  for (const para of text.split(/\n{2,}/)) {
    const toks = encode(para);
    if (toks.length > TARGET_TOKENS) {
      // Oversized paragraph: flush pending content, then emit each token-window directly.
      // The windows already overlap each other (step = TARGET - OVERLAP) and are each
      // <= TARGET, so they need no extra packing/overlap and stay within budget.
      // Deliberate gap: no overlap is carried from the last window into the NEXT
      // paragraph (would need an explicit tail-carry); revisit if the Phase 3 eval shows
      // boundary-straddling questions suffer.
      emit();
      tokenWindows(toks).forEach(add);
      continue;
    }
    const t = toks.length;
    if (bufTokens > 0 && bufTokens + t > TARGET_TOKENS) {
      const prevBody = buf.join("\n\n");
      emit();
      // Carry the last OVERLAP_TOKENS of the emitted chunk as the next chunk's prefix.
      // BPE decode concatenates token strings, so decode(tokens.slice(-k)) is exactly
      // the text suffix for those tokens -> guaranteed, deterministic overlap. Counted
      // toward bufTokens so overlap + packed units stays within the target budget.
      const prevTokens = encode(prevBody);
      const tail = prevTokens.slice(Math.max(0, prevTokens.length - OVERLAP_TOKENS));
      buf = [decode(tail)];
      bufTokens = tail.length;
    }
    buf.push(para);
    bufTokens += t;
  }
  emit();
  return chunks;
}
