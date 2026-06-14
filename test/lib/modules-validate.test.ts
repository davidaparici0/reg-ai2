import { describe, expect, it } from "vitest";
import { CreateModule, PatchModule, ProgressUpdate } from "@/lib/modules/validate";

const goodContent = { body: "Lesson text", documentIds: [crypto.randomUUID()], menuItemIds: [crypto.randomUUID()] };

describe("CreateModule", () => {
  it("accepts a minimal valid module (title + content.body)", () => {
    expect(CreateModule.safeParse({ title: "Wine 101", content: { body: "hi" } }).success).toBe(true);
  });
  it("accepts content with tenant ref arrays and an explicit position", () => {
    expect(CreateModule.safeParse({ title: "T", description: null, content: goodContent, position: 3 }).success).toBe(true);
  });
  it("rejects missing title, missing content, empty body, oversize body", () => {
    expect(CreateModule.safeParse({ content: { body: "x" } }).success).toBe(false);
    expect(CreateModule.safeParse({ title: "T" }).success).toBe(false);
    expect(CreateModule.safeParse({ title: "T", content: { body: "" } }).success).toBe(false);
    expect(CreateModule.safeParse({ title: "T", content: { body: "x".repeat(50_001) } }).success).toBe(false);
  });
  it("rejects bad uuids, >50 refs, and unknown keys", () => {
    expect(CreateModule.safeParse({ title: "T", content: { body: "x", documentIds: ["nope"] } }).success).toBe(false);
    expect(CreateModule.safeParse({ title: "T", content: { body: "x", menuItemIds: Array(51).fill(crypto.randomUUID()) } }).success).toBe(false);
    expect(CreateModule.safeParse({ title: "T", content: { body: "x" }, surprise: 1 }).success).toBe(false);
    expect(CreateModule.safeParse({ title: "T", content: { body: "x", extra: 1 } }).success).toBe(false);
  });
});

describe("PatchModule", () => {
  it("accepts a single-field patch and rejects an empty one", () => {
    expect(PatchModule.safeParse({ title: "New" }).success).toBe(true);
    expect(PatchModule.safeParse({ position: 2 }).success).toBe(true);
    expect(PatchModule.safeParse({ description: null }).success).toBe(true);
    expect(PatchModule.safeParse({}).success).toBe(false);
  });
});

describe("ProgressUpdate", () => {
  it("accepts in_progress/completed only", () => {
    expect(ProgressUpdate.safeParse({ status: "in_progress" }).success).toBe(true);
    expect(ProgressUpdate.safeParse({ status: "completed" }).success).toBe(true);
    expect(ProgressUpdate.safeParse({ status: "not_started" }).success).toBe(false);
    expect(ProgressUpdate.safeParse({ status: "done" }).success).toBe(false);
  });
});
