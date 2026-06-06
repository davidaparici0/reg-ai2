// bytes -> plain text, dispatched by source type. PDF only for the MVP slice (FR-005);
// the registry shape means DOCX/text are a later registration, not a rewrite.
import { extractText, getDocumentProxy } from "unpdf";

export type SourceType = "pdf" | "docx" | "text";

async function parsePdf(bytes: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

const PARSERS: Partial<Record<SourceType, (b: Buffer) => Promise<string>>> = {
  pdf: parsePdf,
};

export async function parse(bytes: Buffer, sourceType: SourceType): Promise<string> {
  const parser = PARSERS[sourceType];
  if (!parser) throw new Error(`unsupported source type: ${sourceType}`);
  return parser(bytes);
}
