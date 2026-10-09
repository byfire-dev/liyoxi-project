// @ts-check
// 唯一许可字体、固定画布与字号；文本文件使内容不能进入过滤器语法。
import { createHash } from "node:crypto";
import { readFile, rm, writeFile, stat, rename } from "node:fs/promises";
import { segmentsOf, outputFile, RequestError } from "./paths.mjs";
import { run } from "./run.mjs";
const FONT = "/app/fonts/NotoSansCJKsc-Regular.otf";
const FONT_SHA = "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b";
/** Parse this fixed font's cmap, so missing glyphs cannot silently replace store text. @param {Buffer} font @param {string} text */
function covers(font, text) {
  const count = font.readUInt16BE(4);
  let cmap = 0;
  for (let i = 0; i < count; i++)
    if (font.toString("ascii", 12 + i * 16, 16 + i * 16) === "cmap")
      cmap = font.readUInt32BE(20 + i * 16);
  const n = font.readUInt16BE(cmap + 2);
  for (let i = 0; i < n; i++) {
    const offset = cmap + font.readUInt32BE(cmap + 8 + i * 8);
    if (font.readUInt16BE(offset) !== 12) continue;
    const groups = font.readUInt32BE(offset + 12);
    return Array.from(text).every((char) => {
      const point = char.codePointAt(0) ?? 0;
      for (let j = 0; j < groups; j++) {
        const group = offset + 16 + j * 12,
          start = font.readUInt32BE(group),
          end = font.readUInt32BE(group + 4);
        if (point >= start && point <= end)
          return font.readUInt32BE(group + 8) + point - start !== 0;
      }
      return false;
    });
  }
  return false;
}
/** @param {any} body */
export async function watermarkPng(body) {
  if (
    Object.keys(body).some((key) => !["outPath", "text", "timeoutMs"].includes(key)) ||
    typeof body.text !== "string" ||
    Buffer.byteLength(body.text) > 256 ||
    /[\p{Cc}\p{Cf}]/u.test(body.text) ||
    !/^样片 · 仅供「.{1,20}」确认 · \d{2}-\d{2}$/u.test(body.text)
  )
    throw new RequestError("bad_request", "水印文案不合规");
  const segments = segmentsOf(body.outPath),
    out = await outputFile(body.outPath, segments[0] ?? "");
  if (!out.endsWith("/watermark.png")) throw new RequestError("bad_path", "水印只写本任务固定文件");
  const font = await readFile(FONT);
  if (createHash("sha256").update(font).digest("hex") !== FONT_SHA)
    throw new RequestError("internal", "固定字体校验失败", 500);
  if (!covers(font, body.text))
    throw new RequestError("unsupported_glyph", "固定许可字体不能完整显示该文案", 422);
  const split = body.text.lastIndexOf(" · "),
    first = body.text.slice(0, split),
    second = body.text.slice(split + 3);
  // 最多10个店名字素；两行保留全部正式文字，720px视频不裁切。
  if (Array.from(first.slice("样片 · 仅供「".length, -"」确认".length)).length > 10)
    throw new RequestError("bad_request", "店名超过10字");
  const part = `${out}.part`,
    a = `${out}.first.txt`,
    b = `${out}.second.txt`;
  const timeout = body.timeoutMs === undefined ? 30_000 : body.timeoutMs;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000)
    throw new RequestError("bad_request", "超时值不合规");
  try {
    await Promise.all([part, a, b].map((path) => rm(path, { force: true })));
    await writeFile(a, first, { flag: "wx", mode: 0o600 });
    await writeFile(b, second, { flag: "wx", mode: 0o600 });
    const filter = `drawtext=fontfile=${FONT}:textfile=${a}:expansion=none:fontsize=28:fontcolor=white:x=(w-text_w)/2:y=8,drawtext=fontfile=${FONT}:textfile=${b}:expansion=none:fontsize=28:fontcolor=white:x=(w-text_w)/2:y=52`;
    const result = await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        "lavfi",
        "-i",
        "color=c=black@0:s=720x96:r=1,format=rgba",
        "-vf",
        filter,
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-dn",
        "-c:v",
        "png",
        "-threads",
        "1",
        "-f",
        "image2",
        "-update",
        "1",
        `file:${part}`,
      ],
      { timeoutMs: timeout, maxStdoutBytes: 0 },
    );
    if (result.timedOut) throw new RequestError("timeout", "水印渲染超时", 504);
    if (result.code !== 0 || result.overflow) throw new RequestError("killed", "水印渲染失败", 503);
    const sizeBytes = (await stat(part)).size;
    if (sizeBytes < 33 || sizeBytes > 1024 ** 2)
      throw new RequestError("too_large", "水印产物超限", 422);
    await rename(part, out);
    return { sizeBytes, width: 720, height: 96 };
  } finally {
    await Promise.all([part, a, b].map((path) => rm(path, { force: true })));
  }
}
