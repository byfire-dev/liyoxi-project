import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createMediaToolClient } from "./client.js";
import { validWatermarkPng } from "./png.js";

function chunk(type: string, body: Buffer) {
  const name = Buffer.from(type),
    data = Buffer.concat([name, body]);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4),
    tail = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, data, tail]);
}
function png(input: { blank?: boolean; edge?: boolean; width?: number } = {}) {
  const width = input.width ?? 720,
    header = Buffer.alloc(13),
    raw = Buffer.alloc((width * 4 + 1) * 96);
  header.writeUInt32BE(width);
  header.writeUInt32BE(96, 4);
  header[8] = 8;
  header[9] = 6;
  if (!input.blank)
    for (const [top, bottom] of [
      [8, 35],
      [52, 79],
    ])
      for (let y = top!; y <= bottom!; y++)
        for (let x = input.edge ? 0 : 100; x < 620; x++)
          raw[(width * 4 + 1) * y + 1 + x * 4 + 3] = 255;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const owned: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((close) => close()));
});
async function fixture(bytes = png()) {
  const root = await mkdtemp("/tmp/lyx-w304-png-");
  await mkdir(join(root, "job"));
  await writeFile(join(root, "job/watermark.png"), bytes);
  const seen: unknown[] = [];
  let response: unknown = { ok: true, sizeBytes: bytes.length, width: 720, height: 96 };
  let hold = false,
    entered!: () => void,
    closed!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const socketClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = createServer((request, reply) => {
    request.socket.once("close", closed);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      entered();
      if (!hold) {
        reply.writeHead(200, { "content-type": "application/json" });
        reply.end(JSON.stringify(response));
      }
    });
  });
  const socketPath = join(root, "mt.sock");
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  owned.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return {
    seen,
    ready,
    socketClosed,
    setResponse: (value: unknown) => {
      response = value;
    },
    hold: () => {
      hold = true;
    },
    client: createMediaToolClient({ workDir: root, socketPath, responseTimeoutMs: 2000 }),
  };
}
const text = "样片 · 仅供「十字商家名称完整店铺」确认 · 10-09";
describe("固定字体水印客户端不信任容器", () => {
  it("严格响应与真实RGBA二行产物一致，文本原样走JSON而非表达式", async () => {
    const f = await fixture(),
      result = await f.client.watermarkPng!({ outPath: "job/watermark.png", text });
    expect(result).toMatchObject({
      ok: true,
      value: { width: 720, height: 96, sizeBytes: png().length },
    });
    expect(f.seen).toEqual([
      { url: "/watermarkPng", body: { outPath: "job/watermark.png", text } },
    ]);
  });
  it("旧文件不能让错误或伪成功应答变为已渲染", async () => {
    const f = await fixture();
    for (const response of [
      { ok: false, error: { code: "unsupported_glyph", message: "controlled" } },
      { ok: true },
      { ok: true, width: 720, height: 96, sizeBytes: 1 },
      { ok: true, width: 720, height: 96, sizeBytes: png().length, extra: "invalid" },
    ]) {
      f.setResponse(response);
      expect(await f.client.watermarkPng!({ outPath: "job/watermark.png", text })).toMatchObject({
        ok: false,
        reason: "rejected",
      });
    }
  });
  it("透明空白/被裁边缘即使CRC合法也拒收，实际两行像素必非空", async () => {
    for (const bytes of [png({ blank: true }), png({ edge: true }), png({ width: 721 })]) {
      const f = await fixture(bytes);
      expect(await f.client.watermarkPng!({ outPath: "job/watermark.png", text })).toMatchObject({
        ok: false,
        reason: "rejected",
      });
    }
  });
  it("坏CRC/尾随字节/超过1MiB拒收，不解压无界数据", () => {
    const corrupt = png();
    corrupt[29] = (corrupt[29] ?? 0) ^ 1;
    expect(validWatermarkPng(corrupt)).toBe(false);
    expect(validWatermarkPng(Buffer.concat([png(), Buffer.from([0])]))).toBe(false);
    expect(validWatermarkPng(Buffer.alloc(1024 ** 2 + 1))).toBe(false);
  });
  it("越目录/额外输出文件名与控制字符在任何请求之前拒绝", async () => {
    const f = await fixture();
    for (const input of [
      { outPath: "../watermark.png", text },
      { outPath: "job/arbitrary.png", text },
      { outPath: "job/watermark.png", text: `${text}\n` },
    ])
      expect(await f.client.watermarkPng!(input)).toMatchObject({ ok: false, reason: "rejected" });
    expect(f.seen).toEqual([]);
  });
  it("已开始的套接字调用响应取消，真实socket先关闭再清场", async () => {
    const f = await fixture(),
      controller = new AbortController();
    f.hold();
    const pending = f.client.watermarkPng!({
      outPath: "job/watermark.png",
      text,
      signal: controller.signal,
    });
    await f.ready;
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, reason: "unavailable" });
    await f.socketClosed;
  });
});
