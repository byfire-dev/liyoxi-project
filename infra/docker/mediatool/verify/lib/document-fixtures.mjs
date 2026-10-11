// @ts-check
// Fictional real ZIP/OPC and ToUnicode PDF fixtures, adapted from the existing
// D6 packages/services/src/testing/document-fixtures.ts algorithm. Built-ins only:
// caller runs without services imports, npm packages, fonts or network access.
import { crc32, deflateRawSync } from "node:zlib";

/** @typedef {{name:string, bytes:Uint8Array, stored?:boolean, descriptor?:boolean}} Part */
/** @param {Part[]} parts */
export function zip(parts) {
  /** @type {Buffer[]} */
  const locals = [],
    directory = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name),
      bytes = Buffer.from(part.bytes);
    const compressed = part.stored ? bytes : deflateRawSync(bytes),
      checksum = crc32(bytes);
    const flags = 0x800 | (part.descriptor ? 8 : 0),
      method = part.stored ? 0 : 8;
    const local = Buffer.alloc(30),
      record = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(name.length, 26);
    if (!part.descriptor) {
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(bytes.length, 22);
    }
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    const descriptor = Buffer.alloc(part.descriptor ? 16 : 0);
    if (part.descriptor) {
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(bytes.length, 12);
    }
    locals.push(local, name, compressed, descriptor);
    directory.push(record, name);
    offset += local.length + name.length + compressed.length + descriptor.length;
  }
  const central = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
/** @param {string} text */
const escape = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
/** @param {string} [text] @param {{tableText?:string, descriptor?:boolean, stored?:boolean}} [options] @returns {Part[]} */
export function docxParts(text = "虚构段落😀", options = {}) {
  const paragraph = (/** @type {string} */ body) =>
    `<w:p><w:r><w:t>${escape(body)}</w:t></w:r></w:p>`;
  const table =
    options.tableText === undefined
      ? ""
      : `<w:tbl><w:tr><w:tc>${paragraph(options.tableText)}</w:tc></w:tr></w:tbl>${paragraph("末段")}`;
  return [
    {
      name: "[Content_Types].xml",
      bytes: Buffer.from(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    },
    {
      name: "_rels/.rels",
      bytes: Buffer.from(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
    },
    {
      name: "word/document.xml",
      bytes: Buffer.from(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
          paragraph(text) +
          table +
          "</w:body></w:document>",
      ),
    },
  ].map((part) => ({ ...part, descriptor: options.descriptor, stored: options.stored }));
}
/** @param {string} [text] @param {Parameters<typeof docxParts>[1]} [options] */
export const docx = (text, options) => zip(docxParts(text, options));

/** Real Chinese/supplementary text layer; empty text produces an actual image-only page.
 * @param {string} [text] @param {number} [pages]
 */
export function pdf(text = "虚构正文😀", pages = 1) {
  const chars = [...new Set([...text])];
  const utf16 = (/** @type {string} */ char) => {
    const bytes = Buffer.from(char, "utf16le");
    bytes.swap16();
    return bytes.toString("hex");
  };
  const hex = (/** @type {number} */ n) => n.toString(16).padStart(4, "0");
  const cmap =
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
    "/CMapName /Fixture def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    chars.length +
    " beginbfchar\n" +
    chars.map((c, i) => `<${hex(i + 1)}> <${utf16(c)}>`).join("\n") +
    "\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
  const stream = text
    ? "BT /F1 12 Tf 10 200 Td <" +
      [...text].map((c) => hex(chars.indexOf(c) + 1)).join("") +
      "> Tj ET"
    : "q 100 0 0 100 0 0 cm /Im0 Do Q";
  const content = (/** @type {string} */ body) =>
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [" +
      Array.from({ length: pages }, (_, i) => `${8 + i} 0 R`).join(" ") +
      `] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /Fixture /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 6 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Fixture /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R /DW 1000 >>",
    "<< /Type /FontDescriptor /FontName /Fixture /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 1000 /Descent 0 /CapHeight 1000 /StemV 80 >>",
    content(cmap),
    content(stream),
    ...Array.from(
      { length: pages },
      () =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${Math.max(600, [...text].length * 12 + 20)} 600] /Resources << /Font << /F1 3 0 R >> /XObject << /Im0 ${8 + pages} 0 R >> >> /Contents 7 0 R >>`,
    ),
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\nRGB\nendstream",
  ];
  const output = ["%PDF-1.7\n"],
    offsets = [0];
  let length = Buffer.byteLength("%PDF-1.7\n");
  objects.forEach((object, i) => {
    offsets.push(length);
    const value = `${i + 1} 0 obj\n${object}\nendobj\n`;
    output.push(value);
    length += Buffer.byteLength(value);
  });
  output.push(
    `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
      offsets
        .slice(1)
        .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
        .join("") +
      `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
  );
  return Buffer.from(output.join(""));
}

// Existing 828-byte fictional encrypted.pdf fixture, copied as inert bytes so the caller
// does not mount/import the host services package. A real /Encrypt dictionary, not a mock.
export const encryptedPdf = () =>
  Buffer.from(
    "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDgwMDNhZjcwMDQ+Cj4+CmVuZG9iagoy" +
      "IDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMg" +
      "MCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9U" +
      "eXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAxMDAgMTAwIF0KL1Bh" +
      "cmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5" +
      "NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8Yjk4NWIxOGRmMTIzNmU4NWJkN2ZlMDg3MDhiNmUw" +
      "ZDQ4YmMyMDk2YjQxY2VmZTVjZjQ0MDBkODQxODg5ZDE5YT4KL1UgPGZmNzM0OWIwN2ZkYzJkYTgzYzE3" +
      "NjNmNzU4YTAyODA5MjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVm" +
      "CjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAw" +
      "MCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAwMDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDI2MSAwMDAw" +
      "MCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDMwMzkz" +
      "NTMzMzE2NjYzMzg2MTM3MzAzMTYzMzczMDYyMzc2MzM3MzIzMzMwMzAzNjM4MzUzNjMyMzYzODY0NjM+" +
      "IDwzMDM5MzUzMzMxNjY2MzM4NjEzNzMwMzE2MzM3MzA2MjM3NjMzNzMyMzMzMDMwMzYzODM1MzYzMjM2" +
      "Mzg2NDYzPiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo0NzYKJSVFT0YK",
    "base64",
  );
