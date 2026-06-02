import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
// vitest 4.x: arrow functions can't be constructors — use a regular function so
// `new OpenAI(...)` works in the module under test.
vi.mock("openai", () => ({ default: vi.fn(function () { return { embeddings: { create } }; }) }));

beforeEach(() => {
  vi.resetModules();
  create.mockReset();
  process.env.OPENAI_API_KEY = "test-key";
});

describe("embed()", () => {
  it("returns one vector per input and surfaces usage tokens", async () => {
    create.mockResolvedValue({
      data: [{ index: 0, embedding: Array(1536).fill(0.1) }, { index: 1, embedding: Array(1536).fill(0.2) }],
      usage: { total_tokens: 42 },
    });
    const { embed } = await import("@/lib/ai/embeddings");
    const res = await embed(["alpha", "beta"]);
    expect(res.vectors).toHaveLength(2);
    expect(res.vectors[0]).toHaveLength(1536);
    expect(res.usageTokens).toBe(42);
    expect(create).toHaveBeenCalledWith({ model: "text-embedding-3-small", input: ["alpha", "beta"] });
  });

  it("short-circuits empty input without calling OpenAI", async () => {
    const { embed } = await import("@/lib/ai/embeddings");
    const res = await embed([]);
    expect(res).toEqual({ vectors: [], usageTokens: 0 });
    expect(create).not.toHaveBeenCalled();
  });

  it("computes cost from the locked per-token price", async () => {
    const { embeddingCostUsd } = await import("@/lib/ai/embeddings");
    expect(embeddingCostUsd(1_000_000)).toBeCloseTo(0.02, 6);
  });

  it("reorders vectors to match input order when the API returns data out of order", async () => {
    create.mockResolvedValue({
      data: [
        { index: 1, embedding: Array(1536).fill(0.9) },
        { index: 0, embedding: Array(1536).fill(0.1) },
      ],
      usage: { total_tokens: 10 },
    });
    const { embed } = await import("@/lib/ai/embeddings");
    const res = await embed(["first", "second"]);
    expect(res.vectors[0][0]).toBe(0.1); // index 0 -> first
    expect(res.vectors[1][0]).toBe(0.9); // index 1 -> second
  });

  it("throws if OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const { embed } = await import("@/lib/ai/embeddings");
    await expect(embed(["x"])).rejects.toThrow("OPENAI_API_KEY is not set");
  });
});
