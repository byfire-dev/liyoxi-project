import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createMediaToolClient } from "./client.js";
import type { ProbeReport } from "./schema.js";

const owned: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of owned.splice(0)) await close();
});
const text = "样片 · 仅供「演示门店」确认 · 10-27";
function report(sizeBytes: number): ProbeReport {
  const stream = {
    index: 0,
    codecType: "video",
    codecName: "h264",
    profile: "High",
    pixFmt: "yuv420p",
    bitsPerRawSample: 8,
    width: 1080,
    height: 1920,
    rotation: 0,
    displayWidth: 1080,
    displayHeight: 1920,
    sampleAspectRatio: "1:1",
    rFrameRate: "30/1",
    avgFrameRate: "30/1",
    nbFrames: 30,
    startTimeMs: 0,
    durationMs: 1000,
    bitRate: 8000,
    sampleRate: null,
    channels: null,
    attachedPic: false,
  };
  return {
    demuxer: "mov",
    format: {
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      majorBrand: "isom",
      durationMs: 1000,
      sizeBytes,
      bitRate: 8000,
      tags: { major_brand: "isom" },
    },
    streams: [
      stream,
      {
        ...stream,
        index: 1,
        codecType: "audio",
        codecName: "aac",
        profile: "LC",
        width: null,
        height: null,
        displayWidth: null,
        displayHeight: null,
        pixFmt: null,
        bitsPerRawSample: null,
        sampleRate: 48000,
        channels: 2,
      },
    ],
    boxes: ["ftyp", "moov", "mdat"],
    moovBeforeMdat: true,
    aigc: null,
  };
}
async function fixture() {
  const workDir = await mkdtemp("/tmp/lyx-wm-sample-");
  await mkdir(join(workDir, "job"));
  const source = Buffer.alloc(64),
    product = Buffer.alloc(1024 * 1024 + 1024, 0x61);
  source.write("ftyp", 4);
  product.write("ftyp", 4);
  await writeFile(join(workDir, "job/source.mp4"), source);
  await writeFile(join(workDir, "job/stamped.mp4"), product);
  const seen: unknown[] = [];
  let response: unknown = {
    ok: true,
    report: report(product.length),
    inputSizeBytes: source.length,
    outputSizeBytes: product.length,
  };
  const server = createServer((request, reply) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(JSON.stringify(response));
    });
  });
  const socketPath = join(workDir, "mt.sock");
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  owned.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workDir, { recursive: true, force: true });
  });
  return {
    workDir,
    source,
    product,
    seen,
    setResponse: (value: unknown) => {
      response = value;
    },
    client: createMediaToolClient({ workDir, socketPath, responseTimeoutMs: 2000 }),
  };
}
const input = { path: "job/source.mp4", outPath: "job/stamped.mp4", text };

describe("真实样片水印客户端", () => {
  it("固定契约走socket，按实际文件量大小/hash，不套用流拷贝的±1MB限制", async () => {
    const f = await fixture();
    const result = await f.client.watermarkSample!({ ...input, timeoutMs: 90_000 });
    expect(result).toEqual({
      ok: true,
      value: {
        report: report(f.product.length),
        inputSizeBytes: f.source.length,
        outputSizeBytes: f.product.length,
        sha256: createHash("sha256").update(f.product).digest("hex"),
      },
    });
    expect(f.seen).toEqual([{ url: "/watermarkSample", body: { ...input, timeoutMs: 90_000 } }]);
  });

  it("路径越界、跨任务、同源覆盖、控制字符与非法超时均不外呼", async () => {
    const f = await fixture();
    for (const change of [
      { path: "../source.mp4" },
      { outPath: "other/stamped.mp4" },
      { outPath: input.path },
      { text: `${text}\n` },
      { text: "movie=https://external.invalid" },
      { timeoutMs: 0 },
      { timeoutMs: 90_001 },
    ]) {
      expect((await f.client.watermarkSample!({ ...input, ...change })).ok).toBe(false);
    }
    expect(f.seen).toEqual([]);
  });

  it("容器虚报大小或非High/非faststart报告均拒收", async () => {
    const f = await fixture();
    const normal = report(f.product.length);
    for (const response of [
      { ok: true, report: normal, inputSizeBytes: f.source.length, outputSizeBytes: 1 },
      {
        ok: true,
        report: { ...normal, moovBeforeMdat: false },
        inputSizeBytes: f.source.length,
        outputSizeBytes: f.product.length,
      },
      {
        ok: true,
        report: {
          ...normal,
          streams: normal.streams.map((stream) =>
            stream.codecType === "video" ? { ...stream, profile: "Baseline" } : stream,
          ),
        },
        inputSizeBytes: f.source.length,
        outputSizeBytes: f.product.length,
      },
    ]) {
      f.setResponse(response);
      expect((await f.client.watermarkSample!(input)).ok).toBe(false);
    }
  });

  it("符号链接产物与预取消请求均不能成为可发布结果", async () => {
    const f = await fixture();
    await rm(join(f.workDir, input.outPath));
    await symlink(join(f.workDir, input.path), join(f.workDir, input.outPath));
    expect((await f.client.watermarkSample!(input)).ok).toBe(false);
    f.seen.length = 0;
    expect((await f.client.watermarkSample!({ ...input, signal: AbortSignal.abort() })).ok).toBe(
      false,
    );
    expect(f.seen).toEqual([]);
  });
});
