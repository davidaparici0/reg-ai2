import { describe, expect, it } from "vitest";
import { parse } from "@/lib/ingest/parse";
import { makeMinimalPdf } from "../helpers/pdf";

describe("parse()", () => {
  it("extracts text from a PDF buffer", async () => {
    const buf = makeMinimalPdf("REG AI ingestion test document");
    const text = await parse(buf, "pdf");
    expect(text).toContain("REG AI ingestion test document");
  });

  it("throws on a non-PDF buffer (so the caller marks the job failed)", async () => {
    await expect(parse(Buffer.from("this is not a pdf"), "pdf")).rejects.toThrow();
  });

  it("throws on an unsupported source type", async () => {
    await expect(parse(Buffer.from("x"), "docx")).rejects.toThrow(/unsupported/i);
  });
});
