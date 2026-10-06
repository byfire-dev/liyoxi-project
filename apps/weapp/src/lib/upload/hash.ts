/** 小程序可用的纯摘要；只用于文件续传标识，不用于密钥或密码。 */
const rotate = (value: number, n: number) => (value << n) | (value >>> (32 - n));
const hex = (value: number) => (value >>> 0).toString(16).padStart(8, "0");
const bytesOf = (text: string) =>
  Uint8Array.from(encodeURIComponent(text).match(/%[0-9A-F]{2}|[^%]/g) ?? [], (part) =>
    part.startsWith("%") ? parseInt(part.slice(1), 16) : part.charCodeAt(0),
  );
function padded(bytes: Uint8Array, little: boolean): Uint32Array {
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const raw = new Uint8Array(length);
  raw.set(bytes);
  raw[bytes.length] = 128;
  const view = new DataView(raw.buffer);
  view.setUint32(length - (little ? 8 : 4), bytes.length * 8, little);
  const words = new Uint32Array(length / 4);
  for (let i = 0; i < words.length; i++) words[i] = view.getUint32(i * 4, little);
  return words;
}
export function md5(bytes: Uint8Array): string {
  const words = padded(bytes, true);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let start = 0; start < words.length; start += 16) {
    let [a, b, c, d] = state as [number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const group = Math.floor(i / 16);
      const f =
        group === 0
          ? (b & c) | (~b & d)
          : group === 1
            ? (d & b) | (~d & c)
            : group === 2
              ? b ^ c ^ d
              : c ^ (b | ~d);
      const g =
        group === 0
          ? i
          : group === 1
            ? (5 * i + 1) % 16
            : group === 2
              ? (3 * i + 5) % 16
              : (7 * i) % 16;
      const next =
        b +
        rotate(
          (a + f + Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) + words[start + g]!) | 0,
          shifts[group * 4 + (i % 4)]!,
        );
      [a, b, c, d] = [d, next | 0, b, c];
    }
    for (const [i, value] of [a, b, c, d].entries()) state[i] = (state[i]! + value) | 0;
  }
  return state.map((value) => hex(value).match(/../g)!.reverse().join("")).join("");
}
export function sha1(text: string): string {
  const words = padded(bytesOf(text), false);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  for (let start = 0; start < words.length; start += 16) {
    const w = Array.from(words.slice(start, start + 16));
    for (let i = 16; i < 80; i++) w[i] = rotate(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    let [a, b, c, d, e] = state as [number, number, number, number, number];
    for (let i = 0; i < 80; i++) {
      const f =
        i < 20
          ? (b & c) | (~b & d)
          : i < 40
            ? b ^ c ^ d
            : i < 60
              ? (b & c) | (b & d) | (c & d)
              : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      [a, b, c, d, e] = [(rotate(a, 5) + f + e + k + w[i]!) | 0, a, rotate(b, 30), c, d];
    }
    for (const [i, value] of [a, b, c, d, e].entries()) state[i] = (state[i]! + value) | 0;
  }
  return state.map(hex).join("");
}
export interface FileFingerprint {
  storeId: string | null;
  category: string;
  size: number;
  durationMs: number;
  width: number;
  height: number;
}
export function clientToken(file: FileFingerprint, head: Uint8Array): string {
  return sha1(
    [
      file.storeId ?? "",
      file.category,
      file.size,
      file.durationMs,
      `${file.width}×${file.height}`,
      md5(head.subarray(0, 256 * 1024)),
    ].join("|"),
  );
}
