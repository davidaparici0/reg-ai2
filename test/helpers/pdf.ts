// Builds a minimal valid single-page PDF containing one line of ASCII text that
// pdf.js (unpdf) extracts. Offsets are computed (latin1 = 1 byte/char) so the xref
// is correct. ASCII text only.
export function makeMinimalPdf(text: string): Buffer {
  // latin1 is 1 byte/char (keeps the xref offsets correct); a char above U+00FF would be
  // silently truncated to its low byte and break the round-trip. Fail loudly instead.
  if (/[^\x00-\xFF]/.test(text)) throw new Error("makeMinimalPdf: ASCII/Latin-1 text only");
  const safe = text.replace(/([()\\])/g, "\\$1");
  const content = `BT /F1 24 Tf 72 700 Td (${safe}) Tj ET`;
  const objects: Record<number, string> = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    4: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    5: `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  };
  const header = "%PDF-1.4\n";
  let body = "";
  const offsets: number[] = [];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = header.length + body.length;
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = header.length + body.length;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(header + body + xref + trailer, "latin1");
}
