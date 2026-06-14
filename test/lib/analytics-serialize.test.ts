import { describe, expect, it } from "vitest";
import { serializeRange, toSummaryResponse, toTraineesResponse } from "@/lib/analytics/serialize";
import type { SummaryStats, TraineeStats } from "@/lib/analytics/queries";

const range = serializeRange(new Date("2026-05-15T00:00:00Z"), new Date("2026-06-14T00:00:00Z"));

const stats: SummaryStats = {
  answered: 5, grounded: 3, traineesTotal: 2, traineesActive: 1, totalCostUsd: "0.030100",
  cost: {
    embedding: { model: "text-embedding-3-small", calls: 5, inputTokens: 50, outputTokens: 0, costUsd: "0.000100" },
    completion: { model: "gpt-4.1-mini", calls: 3, inputTokens: 300, outputTokens: 60, costUsd: "0.030000" },
  },
};

describe("serializeRange", () => {
  it("emits ISO strings and a null since for 'all'", () => {
    expect(range).toEqual({ since: "2026-05-15T00:00:00.000Z", until: "2026-06-14T00:00:00.000Z" });
    expect(serializeRange(null, new Date("2026-06-14T00:00:00Z")).since).toBeNull();
  });
});

describe("toSummaryResponse", () => {
  it("derives fallback, groundingRate, and perAnswerUsd", () => {
    const out = toSummaryResponse("30d", range, stats);
    expect(out.questions).toEqual({ answered: 5, grounded: 3, fallback: 2, groundingRate: 0.6 });
    expect(out.trainees).toEqual({ total: 2, active: 1 });
    expect(out.cost.totalUsd).toBe("0.030100");
    expect(out.cost.perAnswerUsd).toBe("0.006020");                 // 0.0301 / 5
    expect(out.cost.byKind.completion.costUsd).toBe("0.030000");
    expect(out.window).toBe("30d");
  });
  it("nulls the rates when there are no answers", () => {
    const empty: SummaryStats = {
      answered: 0, grounded: 0, traineesTotal: 0, traineesActive: 0, totalCostUsd: "0.000000",
      cost: { embedding: { model: null, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: "0.000000" },
              completion: { model: null, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: "0.000000" } },
    };
    const out = toSummaryResponse("all", serializeRange(null, new Date("2026-06-14T00:00:00Z")), empty);
    expect(out.questions.groundingRate).toBeNull();
    expect(out.cost.perAnswerUsd).toBeNull();
  });
});

describe("toTraineesResponse", () => {
  it("maps rows and ISO-formats lastActiveAt (null stays null)", () => {
    const ts: TraineeStats = { modulesTotal: 3, rows: [
      { userId: "u1", email: "a@x", questionsAsked: 2, modulesCompleted: 2, lastActiveAt: new Date("2026-06-13T00:00:00Z") },
      { userId: "u2", email: "b@x", questionsAsked: 0, modulesCompleted: 0, lastActiveAt: null },
    ] };
    const out = toTraineesResponse("30d", range, ts);
    expect(out.trainees[0]).toEqual({ user: { id: "u1", email: "a@x" }, questionsAsked: 2, modulesCompleted: 2, modulesTotal: 3, lastActiveAt: "2026-06-13T00:00:00.000Z" });
    expect(out.trainees[1].lastActiveAt).toBeNull();
    expect(out.trainees[1].modulesTotal).toBe(3);
  });
});
