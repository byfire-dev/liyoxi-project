import { deflateRawSync, crc32 } from "node:zlib";

export interface ZipPart {
  name: string;
  bytes: Uint8Array;
  stored?: boolean;
  descriptor?: boolean;
  declaredSize?: number;
}
export function zip(parts: ZipPart[]): Uint8Array {
  const locals: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name),
      content = Buffer.from(part.bytes);
    const compressed = part.stored ? content : deflateRawSync(content),
      checksum = crc32(content);
    const flags = 0x800 | (part.descriptor ? 8 : 0),
      method = part.stored ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(name.length, 26);
    if (!part.descriptor) {
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(part.declaredSize ?? content.length, 22);
    }
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(part.declaredSize ?? content.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    const descriptor = Buffer.alloc(part.descriptor ? 16 : 0);
    if (part.descriptor) {
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(content.length, 12);
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
const xml = (text: string) => Buffer.from(text);
const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export function docxParts(text = "狸有戏虚构协议 测试门店 123", descriptor = false): ZipPart[] {
  return [
    {
      name: "[Content_Types].xml",
      descriptor,
      bytes: xml(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    },
    {
      name: "_rels/.rels",
      descriptor,
      bytes: xml(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
    },
    {
      name: "word/document.xml",
      descriptor,
      bytes: xml(
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>' +
          escape(text) +
          "</w:t></w:r></w:p></w:body></w:document>",
      ),
    },
  ];
}
export function docx(text?: string, descriptor = false): Uint8Array {
  return zip(docxParts(text, descriptor));
}
/** Valid OPC document with inert unreferenced binary parts, exactly the existing upload byte limit. */
export function boundaryDocx(): Uint8Array {
  const parts = docxParts();
  const fillers: ZipPart[] = [1, 2, 3].map((i) => ({
    name: `word/unused${i}.bin`,
    bytes: new Uint8Array(),
    stored: true,
  }));
  const remaining = 20 * 1024 * 1024 - zip([...parts, ...fillers]).byteLength;
  fillers[0]!.bytes = new Uint8Array(7 * 1024 * 1024);
  fillers[1]!.bytes = new Uint8Array(7 * 1024 * 1024);
  fillers[2]!.bytes = new Uint8Array(remaining - 14 * 1024 * 1024);
  return zip([...parts, ...fillers]);
}
/** A real PDF with an explicit ToUnicode CMap, including Chinese, without any font/network dependency. */
export function pdf(text = "狸有戏虚构协议 测试门店 123", pages = 1, boundary = false): Uint8Array {
  const chars = [...new Set([...text])];
  const utf16 = (char: string) => {
    const b = Buffer.from(char, "utf16le");
    b.swap16();
    return b.toString("hex");
  };
  const hex = (n: number) => n.toString(16).padStart(4, "0");
  const cmap =
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Fixture def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    chars.length +
    " beginbfchar\n" +
    chars.map((c, i) => "<" + hex(i + 1) + "> <" + utf16(c) + ">").join("\n") +
    "\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
  const fontSize = [...text].length > 1000 ? 4 : 12;
  const stream = text
    ? "BT /F1 " +
      fontSize +
      " Tf 10 200 Td <" +
      [...text].map((c) => hex(chars.indexOf(c) + 1)).join("") +
      "> Tj ET"
    : "q 100 0 0 100 0 0 cm /Im0 Do Q";
  const content = (value: string) =>
    `<< /Length ${Buffer.byteLength(value)} >>\nstream\n${value}\nendstream`;
  const width = Math.max(600, [...text].length * fontSize + 20); // Keep every test glyph inside the page, rather than PDF.js clipping the budget fixture.
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [" +
      Array.from({ length: pages }, (_, i) => `${8 + i} 0 R`).join(" ") +
      "] /Count " +
      pages +
      " >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /Fixture /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 6 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Fixture /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R /DW 1000 >>",
    "<< /Type /FontDescriptor /FontName /Fixture /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 1000 /Descent 0 /CapHeight 1000 /StemV 80 >>",
    content(cmap),
    content(stream),
    ...Array.from(
      { length: pages },
      () =>
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " +
        width +
        " 600] /Resources << /Font << /F1 3 0 R >> /XObject << /Im0 " +
        (8 + pages) +
        " 0 R >> >> /Contents 7 0 R >>",
    ),
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\nRGB\nendstream",
  ];
  const output = ["%PDF-1.7\n"];
  const offsets = [0];
  let length = Buffer.byteLength(output[0]!);
  objects.forEach((object, i) => {
    offsets.push(length);
    const value = `${i + 1} 0 obj\n${object}\nendobj\n`;
    output.push(value);
    length += Buffer.byteLength(value);
  });
  const xref =
    "xref\n0 " +
    offsets.length +
    "\n0000000000 65535 f \n" +
    offsets
      .slice(1)
      .map((p) => String(p).padStart(10, "0") + " 00000 n \n")
      .join("") +
    "trailer\n<< /Size " +
    offsets.length +
    " /Root 1 0 R >>\nstartxref\n" +
    length +
    "\n%%EOF\n";
  let tail = xref;
  if (boundary) {
    let start = 20 * 1024 * 1024 - Buffer.byteLength(tail);
    tail = xref.replace("startxref\n" + length, "startxref\n" + start);
    start = 20 * 1024 * 1024 - Buffer.byteLength(tail);
    tail = xref.replace("startxref\n" + length, "startxref\n" + start);
    const fill = start - length;
    output.push("%" + " ".repeat(fill - 2) + "\n");
  }
  output.push(tail);
  return Buffer.from(output.join(""));
}
