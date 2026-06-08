import { describe, expect, it } from "vitest";
import { buildPrompt, FALLBACK_TEXT } from "@/lib/qa/prompt";
import type { RetrievedChunk } from "@/lib/qa/retrieve";

const chunk = (id: string, text: string): RetrievedChunk =>
  ({ chunkId: id, documentId: "d", documentTitle: "Doc", text, similarity: 0.9 });

describe("buildPrompt()", () => {
  it("returns a system+user pair with numbered context and the restaurant name", () => {
    const msgs = buildPrompt("Le Test", [chunk("1", "AAA"), chunk("2", "BBB")], "what is X?");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("Le Test");
    expect(msgs[0].content).toContain("[1] AAA");
    expect(msgs[0].content).toContain("[2] BBB");
    expect(msgs[0].content).toContain(FALLBACK_TEXT);
    expect(msgs[1]).toEqual({ role: "user", content: "what is X?" });
  });

  it("exports a non-empty fallback string", () => {
    expect(FALLBACK_TEXT.length).toBeGreaterThan(0);
  });
});
