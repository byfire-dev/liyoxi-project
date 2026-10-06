import type { Media } from "./runtime.js";
/** 可解析的单页 PDF：正文显式标占位；法务正式文本仍由 docs 留桩控制。 */
export function placeholderPdf(key: string): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 16 Tf 50 780 Td (PLACEHOLDER - ${key}) Tj ET`;
  objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  let text = "%PDF-1.4\n% 占位协议，仅用于本地/预发演示\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text +=
    `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
      .join("");
  text += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}
export async function seedPlaceholderFiles(
  media: Pick<Media, "putSystemFile">,
  keys: readonly string[],
) {
  const files: Record<string, { pdfFileId: string; sha256: string }> = {};
  let inserted = 0;
  for (const key of keys) {
    const file = await media.putSystemFile({
      category: "legal_doc",
      fileName: `${key}.pdf`,
      objectKey: `legal_doc/demo-agreement-${key}.pdf`,
      body: placeholderPdf(key),
      entityId: null,
      storeId: null,
    });
    files[key] = { pdfFileId: file.fileId, sha256: file.sha256 };
    if (file.created) inserted += 1;
  }
  return { files, tables: [{ table: "file_object", inserted, existing: keys.length - inserted }] };
}
