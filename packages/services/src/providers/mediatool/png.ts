import { inflateSync } from "node:zlib";
/** CRCs, fixed RGBA geometry and bounded decompression: a container response is untrusted. */
export function validWatermarkPng(bytes: Uint8Array): boolean {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    b.length < 33 ||
    b.length > 1024 ** 2 ||
    b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  )
    return false;
  let offset = 8,
    header = false,
    ended = false,
    seenData = false,
    dataClosed = false;
  const chunks: Buffer[] = [];
  while (offset + 12 <= b.length) {
    const size = b.readUInt32BE(offset),
      end = offset + size + 12;
    if (size > 1024 ** 2 || end > b.length) return false;
    const type = b.toString("ascii", offset + 4, offset + 8),
      body = b.subarray(offset + 8, end - 4);
    let crc = 0xffffffff;
    for (const byte of b.subarray(offset + 4, end - 4)) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    if ((crc ^ 0xffffffff) >>> 0 !== b.readUInt32BE(end - 4)) return false;
    if (!header && type !== "IHDR") return false;
    if (type === "IHDR") {
      if (
        header ||
        size !== 13 ||
        body.readUInt32BE(0) !== 720 ||
        body.readUInt32BE(4) !== 96 ||
        body[8] !== 8 ||
        body[9] !== 6 ||
        body[10] !== 0 ||
        body[11] !== 0 ||
        body[12] !== 0
      )
        return false;
      header = true;
    } else if (type === "IDAT") {
      if (dataClosed || !size) return false;
      seenData = true;
      chunks.push(body);
    } else if (type === "IEND") {
      if (size || !seenData || end !== b.length) return false;
      ended = true;
    } else {
      if (!["pHYs", "sRGB", "gAMA", "cHRM"].includes(type)) return false;
      if (seenData) dataClosed = true;
    }
    offset = end;
  }
  if (!header || !ended || offset !== b.length) return false;
  try {
    const stride = 720 * 4 + 1,
      pixels = inflateSync(Buffer.concat(chunks), { maxOutputLength: stride * 96 });
    if (pixels.length !== stride * 96) return false;
    const row = Buffer.alloc(stride - 1),
      previous = Buffer.alloc(stride - 1);
    const seen = [false, false];
    for (let y = 0; y < 96; y++) {
      const filter = pixels[y * stride];
      if (filter === undefined || filter > 4) return false;
      for (let i = 0; i < row.length; i++) {
        const left = i >= 4 ? row[i - 4]! : 0,
          up = previous[i]!,
          diagonal = i >= 4 ? previous[i - 4]! : 0;
        const p = left + up - diagonal,
          a = Math.abs(p - left),
          c = Math.abs(p - diagonal),
          u = Math.abs(p - up);
        const predictor =
          filter === 0
            ? 0
            : filter === 1
              ? left
              : filter === 2
                ? up
                : filter === 3
                  ? Math.floor((left + up) / 2)
                  : a <= u && a <= c
                    ? left
                    : u <= c
                      ? up
                      : diagonal;
        row[i] = (pixels[y * stride + 1 + i]! + predictor) & 255;
      }
      for (let x = 0; x < 720; x++)
        if (row[x * 4 + 3]) {
          if (x === 0 || x === 719 || y === 0 || y === 95) return false;
          seen[y < 48 ? 0 : 1] = true;
        }
      row.copy(previous);
    }
    return seen.every(Boolean);
  } catch {
    return false;
  }
}
