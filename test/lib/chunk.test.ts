import { describe, expect, it } from "vitest";
import { encode } from "gpt-tokenizer/encoding/cl100k_base";
import { chunk, normalize, TARGET_TOKENS, OVERLAP_TOKENS } from "@/lib/ingest/chunk";

const big = (paras: number) =>
  Array.from({ length: paras }, (_, i) =>
    `Paragraph ${i}. ` + "word ".repeat(120)).join("\n\n");

describe("chunk()", () => {
  it("is deterministic — same input yields identical chunks", () => {
    const text = big(10);
    expect(chunk(text)).toEqual(chunk(text));
  });

  it("indexes chunks sequentially from 0", () => {
    const c = chunk(big(10));
    expect(c.map((x) => x.chunkIndex)).toEqual(c.map((_, i) => i));
  });

  it("keeps every chunk within the token bound and reports accurate token_count", () => {
    for (const c of chunk(big(20))) {
      expect(c.tokenCount).toBe(encode(c.text).length);
      expect(c.tokenCount).toBeLessThanOrEqual(TARGET_TOKENS + OVERLAP_TOKENS);
      expect(c.tokenCount).toBeGreaterThan(0);
    }
  });

  it("overlaps every consecutive chunk pair (tail of one appears at head of the next)", () => {
    const c = chunk(big(20)); // all small paragraphs -> every transition is normal packing
    expect(c.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < c.length - 1; i++) {
      // chunk[i+1] begins with text carried from the end of chunk[i].
      expect(c[i].text).toContain(c[i + 1].text.slice(0, 20));
    }
  });

  it("stays within the token bound when a near-target paragraph is mixed with small ones", () => {
    const near = "word ".repeat(480); // < TARGET, so not hard-split; exercises overlap-prefix + a big unit
    const c = chunk(["short intro paragraph", near, "tiny", "another small paragraph"].join("\n\n"));
    expect(c.length).toBeGreaterThanOrEqual(1);
    for (const x of c) {
      expect(x.tokenCount).toBe(encode(x.text).length);
      expect(x.tokenCount).toBeLessThanOrEqual(TARGET_TOKENS + OVERLAP_TOKENS);
    }
  });

  it("hard-splits a single oversized unit into multiple bounded chunks", () => {
    const oneHugeParagraph = "word ".repeat(2000); // ~2000 tokens, no blank lines
    const c = chunk(oneHugeParagraph);
    expect(c.length).toBeGreaterThan(1);
    for (const x of c) expect(x.tokenCount).toBeLessThanOrEqual(TARGET_TOKENS + OVERLAP_TOKENS);
  });

  it("returns [] for empty / whitespace-only input", () => {
    expect(chunk("   \n\n  ")).toEqual([]);
  });

  it("normalize collapses whitespace and newlines deterministically", () => {
    expect(normalize("a  \t b\r\n\r\n\r\nc")).toBe("a b\n\nc");
  });
});
