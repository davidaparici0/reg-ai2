import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
// vitest 4.x: a factory used as a CONSTRUCTOR must be a regular function, not an arrow.
vi.mock("openai", () => ({ default: vi.fn(function () { return { chat: { completions: { create } } }; }) }));

beforeEach(() => {
  vi.resetModules();
  create.mockReset();
  process.env.OPENAI_API_KEY = "test-key";
});

describe("generate()", () => {
  it("returns trimmed text + token usage and calls the locked model at temperature 0", async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: "  The answer [1].  " } }],
      usage: { prompt_tokens: 120, completion_tokens: 18 },
    });
    const { generate } = await import("@/lib/ai/generate");
    const out = await generate([{ role: "user", content: "hi" }]);
    expect(out.text).toBe("The answer [1].");
    expect(out.inputTokens).toBe(120);
    expect(out.outputTokens).toBe(18);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4.1-mini", temperature: 0 }),
    );
  });

  it("computes completion cost from the locked per-token prices", async () => {
    const { completionCostUsd } = await import("@/lib/ai/generate");
    // 1M input + 1M output at $0.40 + $1.60
    expect(completionCostUsd(1_000_000, 1_000_000)).toBeCloseTo(2.0, 6);
  });
});
