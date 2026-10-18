import { createInflateRaw, crc32 } from "node:zlib";
import { DOCUMENT_LIMITS as L } from "./limits.js";
import { DocumentFailure } from "./types.js";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const invalid = () => {
  throw new DocumentFailure("invalid_document", "source");
};
const unsupported = () => {
  throw new DocumentFailure("unsupported_document", "source");
};
const oversized = () => {
  throw new DocumentFailure("too_large", "source");
};
interface Entry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

/** Inspect both directory claims and actual inflation before Mammoth may see the ZIP. */
export async function validateDocxZip(bytes: Uint8Array): Promise<void> {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length > L.fileBytes) oversized();
  if (data.length < 22 || data.readUInt32LE(0) !== 0x04034b50) invalid();
  let end = -1;
  for (let p = data.length - 22; p >= Math.max(0, data.length - 65557); p--) {
    if (data.readUInt32LE(p) === 0x06054b50 && p + 22 + data.readUInt16LE(p + 20) === data.length) {
      end = p;
      break;
    }
  }
  if (end < 0) invalid();
  const count = data.readUInt16LE(end + 10),
    length = data.readUInt32LE(end + 12),
    start = data.readUInt32LE(end + 16);
  if (
    data.readUInt16LE(end + 4) ||
    data.readUInt16LE(end + 6) ||
    data.readUInt16LE(end + 8) !== count ||
    count === 0xffff ||
    start === 0xffffffff ||
    length === 0xffffffff
  )
    unsupported();
  if (!count || count > L.entries) oversized();
  if (start + length !== end) invalid();
  const entries: Entry[] = [],
    names = new Set<string>();
  let cursor = start,
    declared = 0;
  const checkExtra = (from: number, length: number) => {
    const stop = from + length;
    while (from < stop) {
      if (from + 4 > stop) invalid();
      const tag = data.readUInt16LE(from),
        size = data.readUInt16LE(from + 2);
      if (tag === 1) unsupported(); // ZIP64 cannot be silently truncated to 32-bit sizes.
      from += 4 + size;
      if (from > stop) invalid();
    }
  };
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50) invalid();
    const flags = data.readUInt16LE(cursor + 8),
      method = data.readUInt16LE(cursor + 10);
    const crc = data.readUInt32LE(cursor + 16),
      compressed = data.readUInt32LE(cursor + 20),
      size = data.readUInt32LE(cursor + 24);
    const nameLen = data.readUInt16LE(cursor + 28),
      extra = data.readUInt16LE(cursor + 30),
      comment = data.readUInt16LE(cursor + 32);
    const offset = data.readUInt32LE(cursor + 42),
      next = cursor + 46 + nameLen + extra + comment;
    if (next > end || !nameLen) invalid();
    if (
      flags & ~0x080e ||
      ![0, 8].includes(method) ||
      data.readUInt16LE(cursor + 34) ||
      [compressed, size, offset].includes(0xffffffff)
    )
      unsupported();
    checkExtra(cursor + 46 + nameLen, extra);
    let name: string;
    try {
      name = utf8.decode(data.subarray(cursor + 46, cursor + 46 + nameLen));
    } catch {
      unsupported();
    }
    name = name!.normalize("NFC");
    const parts = name.replace(/\/$/, "").split("/");
    if (
      /[\\:]/u.test(name) ||
      name.includes("\0") ||
      parts.some((part) => !part || part === "." || part === "..") ||
      names.has(name)
    )
      invalid();
    const mode = (data.readUInt32LE(cursor + 38) >>> 16) & 0xf000;
    if (mode && mode !== 0x8000 && mode !== 0x4000) unsupported();
    if (/vba(project\.bin|data\.xml)$/i.test(name)) unsupported();
    if (size > L.entryBytes || size > compressed * L.ratio || (declared += size) > L.expandedBytes)
      oversized();
    if (method === 0 && compressed !== size) invalid();
    names.add(name);
    entries.push({ name, flags, method, crc, compressed, size, offset });
    cursor = next;
  }
  if (
    cursor !== end ||
    !["[Content_Types].xml", "_rels/.rels", "word/document.xml"].every((name) => names.has(name))
  )
    invalid();
  let previousEnd = 0,
    expanded = 0;
  for (const entry of entries.sort((a, b) => a.offset - b.offset)) {
    const p = entry.offset;
    if (p < previousEnd || p + 30 > start || data.readUInt32LE(p) !== 0x04034b50) invalid();
    const nameLen = data.readUInt16LE(p + 26),
      extra = data.readUInt16LE(p + 28),
      from = p + 30 + nameLen + extra,
      to = from + entry.compressed;
    if (
      to > start ||
      data.readUInt16LE(p + 6) !== entry.flags ||
      data.readUInt16LE(p + 8) !== entry.method
    )
      invalid();
    checkExtra(p + 30 + nameLen, extra);
    if (utf8.decode(data.subarray(p + 30, p + 30 + nameLen)).normalize("NFC") !== entry.name)
      invalid();
    if (entry.flags & 8) {
      const matches = (pos: number) =>
        pos + 12 <= start &&
        data.readUInt32LE(pos) === entry.crc &&
        data.readUInt32LE(pos + 4) === entry.compressed &&
        data.readUInt32LE(pos + 8) === entry.size;
      if (to + 4 <= start && data.readUInt32LE(to) === 0x08074b50 && matches(to + 4))
        previousEnd = to + 16;
      else if (matches(to)) previousEnd = to + 12;
      else invalid();
    } else {
      if (
        data.readUInt32LE(p + 14) !== entry.crc ||
        data.readUInt32LE(p + 18) !== entry.compressed ||
        data.readUInt32LE(p + 22) !== entry.size
      )
        invalid();
      previousEnd = to;
    }
    let size = 0,
      checksum = 0;
    const chunks: Uint8Array[] = [];
    const account = (chunk: Uint8Array) => {
      size += chunk.byteLength;
      expanded += chunk.byteLength;
      if (size > L.entryBytes || size > entry.compressed * L.ratio || expanded > L.expandedBytes)
        oversized();
      checksum = crc32(chunk, checksum);
      if (/\.(xml|rels)$/i.test(entry.name)) chunks.push(chunk);
    };
    if (entry.method === 0) account(data.subarray(from, to));
    else {
      const stream = createInflateRaw();
      stream.end(data.subarray(from, to));
      try {
        for await (const chunk of stream) account(chunk as Uint8Array);
      } finally {
        stream.destroy();
      }
      if (stream.bytesWritten !== entry.compressed) invalid();
    }
    if (size !== entry.size || checksum !== entry.crc) invalid();
    if (chunks.length) {
      const xml = utf8.decode(Buffer.concat(chunks));
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) unsupported();
      if (entry.name === "[Content_Types].xml" && /macroenabled|vbaProject/i.test(xml))
        unsupported();
    }
  }
}
