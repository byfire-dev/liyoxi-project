import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createMediaToolClient, jpegDimensions } from "./client.js";
import { aigcMetadataJson, AigcLabelSchema, parseAigc } from "./schema.js";
import type { AigcLabel, ProbeReport } from "./schema.js";

// 调用端不信任容器的输出（X-02 任务书 第 7 节第 7 条）。这里不起容器：一个假的套接字服务扮演 mediatool，
// 想让它答什么就答什么；共享目录是临时目录，“容器的产物”由用例自己写进去。
// 真容器上的验证在 infra/docker/mediatool/verify/（pnpm mediatool:verify）。

const MB = 1024 * 1024;

// 套接字路径有长度上限（macOS 104 字节）。系统临时目录太深时退到 /tmp
const base = mkdtempSync(join(tmpdir().length > 60 ? "/tmp" : tmpdir(), "lyx-mt-"));
const workDir = join(base, "work");
const socketPath = join(base, "mt.sock");

type Reply =
  { status?: number; json: unknown } | { status?: number; raw: string | Buffer } | "hang" | "drop";
let reply: (request: { method: string; url: string; body: unknown }) => Reply = () => "hang";
const seen: Array<{ method: string; url: string; body: unknown }> = [];

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    const request = {
      method: req.method ?? "",
      url: req.url ?? "",
      body: text === "" ? undefined : (JSON.parse(text) as unknown),
    };
    seen.push(request);
    const answer = reply(request);
    if (answer === "hang") return;
    if (answer === "drop") {
      // 说好有 100 字节，只发 4 个就断
      res.writeHead(200, { "content-type": "application/json", "content-length": 100 });
      res.write('{"ok', () => res.socket?.destroy());
      return;
    }
    const payload = "raw" in answer ? answer.raw : JSON.stringify(answer.json);
    res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
    res.end(payload);
  });
});

beforeAll(async () => {
  mkdirSync(join(workDir, "job"), { recursive: true });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(() => {
  seen.length = 0;
  reply = () => "hang";
  server.closeAllConnections();
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(base, { recursive: true, force: true });
});

const client = createMediaToolClient({ socketPath, workDir, responseTimeoutMs: 2000 });

const LABEL: AigcLabel = {
  Label: "1",
  ContentProducer: "LYX-TEST-PLACEHOLDER",
  ProduceID: "lyx-test-0001",
  ReservedCode1: "",
  ContentPropagator: "",
  PropagateID: "",
  ReservedCode2: "",
};
const AIGC_JSON = aigcMetadataJson(LABEL);

function reportOf(over: Partial<ProbeReport> = {}): ProbeReport {
  return {
    demuxer: "mov",
    format: {
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      majorBrand: "isom",
      durationMs: 6000,
      sizeBytes: 4_500_000,
      bitRate: 6_000_000,
      tags: { major_brand: "isom" },
    },
    streams: [
      {
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
        nbFrames: 180,
        startTimeMs: 0,
        durationMs: 6000,
        bitRate: 5_800_000,
        sampleRate: null,
        channels: null,
        attachedPic: false,
      },
    ],
    boxes: ["ftyp", "moov", "free", "mdat"],
    moovBeforeMdat: true,
    aigc: null,
    ...over,
  };
}

/** 一个结构上合法的 JPEG：SOI、SOF0（带尺寸）、填充、EOI */
function jpegOf(width: number, height: number, totalBytes = 64): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  const filler = Buffer.alloc(Math.max(0, totalBytes - 2 - sof.length - 2), 0x55);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, filler, Buffer.from([0xff, 0xd9])]);
}

const inWork = (name: string) => join(workDir, "job", name);
const posterInput = {
  path: "job/in.mp4",
  demuxer: "mov",
  atMs: 1000,
  outPath: "job/poster.jpg",
} as const;
const stampInput = { path: "job/in.mp4", outPath: "job/out.mp4", aigcJson: AIGC_JSON } as const;

describe("mediatool 调用端：正常应答", () => {
  it("probe 把请求原样发到套接字，报告过 Zod 后返回", async () => {
    reply = () => ({
      json: { ok: true, report: reportOf({ aigc: AIGC_JSON }), extra: "多出来的键被丢掉" },
    });
    const result = await client.probe({ path: "job/in.mp4", demuxers: ["mov"] });
    expect(result).toEqual({ ok: true, value: reportOf({ aigc: AIGC_JSON }) });
    expect(seen).toEqual([
      { method: "POST", url: "/probe", body: { path: "job/in.mp4", demuxers: ["mov"] } },
    ]);
    expect(result.ok && parseAigc(result.value)).toEqual(LABEL);
  });

  it("health 给出容器里的 ffmpeg 版本", async () => {
    reply = () => ({
      json: {
        ok: true,
        service: "mediatool",
        ffmpeg: "5.1.9-0+deb12u1",
        ffprobe: "5.1.9-0+deb12u1",
      },
    });
    expect(await client.health()).toEqual({
      ok: true,
      value: { ffmpeg: "5.1.9-0+deb12u1", ffprobe: "5.1.9-0+deb12u1" },
    });
  });

  it("AIGC 的 JSON 七个字段按标准的顺序写；多一个字段、少一个字段都不算", () => {
    expect(AIGC_JSON).toBe(
      '{"Label":"1","ContentProducer":"LYX-TEST-PLACEHOLDER","ProduceID":"lyx-test-0001","ReservedCode1":"","ContentPropagator":"","PropagateID":"","ReservedCode2":""}',
    );
    expect(AigcLabelSchema.safeParse({ ...LABEL, Extra: "x" }).success).toBe(false);
    const { ReservedCode2: _dropped, ...six } = LABEL;
    expect(AigcLabelSchema.safeParse(six).success).toBe(false);
    expect(parseAigc({ aigc: "不是 JSON" })).toBeNull();
    expect(parseAigc({ aigc: JSON.stringify(six) })).toBeNull();
    expect(parseAigc({ aigc: null })).toBeNull();
  });
});

describe("mediatool 调用端：不信任容器的输出", () => {
  it("超过 4MB 的 JSON 被拒", async () => {
    const huge = {
      ok: true,
      report: reportOf({ format: { ...reportOf().format, tags: { pad: "x".repeat(4 * MB) } } }),
    };
    reply = () => ({ json: huge });
    const result = await client.probe({ path: "job/in.mp4", demuxers: ["mov"] });
    expect(result).toEqual({ ok: false, reason: "rejected", message: "mediatool 的应答超过 4MB" });
  });

  it("结构不符的 JSON 被拒：缺字段、类型不对、不是 JSON", async () => {
    const { moovBeforeMdat: _dropped, ...missing } = reportOf();
    const replies: Reply[] = [
      { json: { ok: true, report: missing } },
      { json: { ok: true, report: { ...reportOf(), streams: "h264" } } },
      { json: { ok: true, report: { ...reportOf(), demuxer: "hls" } } },
      { json: { ok: true } },
      { json: { report: reportOf() } },
      { json: ["ok"] },
      { raw: "<html>502</html>" },
      { raw: "" },
    ];
    for (const answer of replies) {
      reply = () => answer;
      const result = await client.probe({ path: "job/in.mp4", demuxers: ["mov"] });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe("rejected");
    }
  });

  it("封面是合法 JPEG 且不超过 1MB 才收；返回的是校验过的那份字节", async () => {
    writeFileSync(inWork("poster.jpg"), jpegOf(1080, 1920, 300_000));
    reply = () => ({ json: { ok: true, sizeBytes: 300_000, atMs: 1000 } });
    const result = await client.poster(posterInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      sizeBytes: 300_000,
      width: 1080,
      height: 1920,
      atMs: 1000,
    });
    expect(jpegDimensions(result.value.bytes)).toEqual({ width: 1080, height: 1920 });
  });

  it("不是 JPEG 的封面被拒", async () => {
    reply = () => ({ json: { ok: true, sizeBytes: 64, atMs: 1000 } });
    const notJpeg = [
      Buffer.from("#!/bin/sh\necho not a jpeg\n"),
      Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(64)]),
      // 起止标记对了，但里面没有带尺寸的 SOF 段
      Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(64, 0x55), Buffer.from([0xff, 0xd9])]),
      // 少了结束标记（被截断）
      jpegOf(1080, 1920).subarray(0, 40),
      Buffer.alloc(0),
    ];
    for (const bytes of notJpeg) {
      writeFileSync(inWork("poster.jpg"), bytes);
      const result = await client.poster(posterInput);
      expect(result).toEqual({ ok: false, reason: "rejected", message: "封面不是合法的 JPEG" });
    }
  });

  it("超过 1MB 的封面被拒", async () => {
    writeFileSync(inWork("poster.jpg"), jpegOf(1080, 1920, MB + 1));
    reply = () => ({ json: { ok: true, sizeBytes: 300_000, atMs: 1000 } });
    const result = await client.poster(posterInput);
    expect(result.ok).toBe(false);
    expect(!result.ok && [result.reason, result.message]).toEqual([
      "rejected",
      `封面 ${MB + 1} 字节，超过 1MB`,
    ]);
  });

  it("容器说办成了但封面不存在，或是指向别处的符号链接：被拒", async () => {
    reply = () => ({ json: { ok: true, sizeBytes: 64, atMs: 0 } });
    rmSync(inWork("poster.jpg"), { force: true });
    expect(await client.poster(posterInput)).toMatchObject({ ok: false, reason: "rejected" });

    writeFileSync(join(base, "outside.jpg"), jpegOf(1080, 1920));
    symlinkSync(join(base, "outside.jpg"), inWork("poster.jpg"));
    const viaLink = await client.poster(posterInput);
    expect(viaLink).toEqual({
      ok: false,
      reason: "rejected",
      message: "job/poster.jpg 经过符号链接",
    });
    rmSync(inWork("poster.jpg"));
  });

  it("加标产物的大小在输入 ±1MB 内、读回的 AIGC 与写入的一致才收", async () => {
    writeFileSync(inWork("in.mp4"), Buffer.alloc(3 * MB));
    writeFileSync(inWork("out.mp4"), Buffer.alloc(3 * MB + 700));
    reply = () => ({
      json: {
        ok: true,
        report: reportOf({ aigc: AIGC_JSON }),
        inputSizeBytes: 1,
        outputSizeBytes: 1,
      },
    });
    const result = await client.stampAigc(stampInput);
    // 大小是调用端自己量的，不用容器报的那两个数
    expect(result).toMatchObject({
      ok: true,
      value: { inputSizeBytes: 3 * MB, outputSizeBytes: 3 * MB + 700 },
    });
    expect(seen[0]?.body).toEqual({
      path: "job/in.mp4",
      outPath: "job/out.mp4",
      aigcJson: AIGC_JSON,
    });
  });

  it("大小超出 ±1MB 的加标产物被拒：变大、变小都算", async () => {
    writeFileSync(inWork("in.mp4"), Buffer.alloc(3 * MB));
    reply = () => ({
      json: {
        ok: true,
        report: reportOf({ aigc: AIGC_JSON }),
        inputSizeBytes: 3 * MB,
        outputSizeBytes: 3 * MB,
      },
    });
    for (const size of [4 * MB + 1, 2 * MB - 1, 0]) {
      writeFileSync(inWork("out.mp4"), Buffer.alloc(size));
      const result = await client.stampAigc(stampInput);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe("rejected");
      expect(!result.ok && result.message).toContain("相差超过 1MB");
    }
    // 正好差 1MB：收
    writeFileSync(inWork("out.mp4"), Buffer.alloc(4 * MB));
    expect((await client.stampAigc(stampInput)).ok).toBe(true);
  });

  it("加标后读不回、或读回的与写入的不一样：被拒", async () => {
    writeFileSync(inWork("in.mp4"), Buffer.alloc(MB));
    writeFileSync(inWork("out.mp4"), Buffer.alloc(MB));
    const other = aigcMetadataJson({ ...LABEL, ProduceID: "someone-else" });
    for (const aigc of [null, other, `${AIGC_JSON} `]) {
      reply = () => ({
        json: { ok: true, report: reportOf({ aigc }), inputSizeBytes: MB, outputSizeBytes: MB },
      });
      expect(await client.stampAigc(stampInput)).toEqual({
        ok: false,
        reason: "rejected",
        message: "加标产物里读回的 AIGC 与写入的不一致",
      });
    }
  });
});

describe("mediatool 调用端：容器不可用", () => {
  it("套接字不存在：返回 unavailable，不抛错", async () => {
    const absent = createMediaToolClient({ socketPath: join(base, "no-such.sock"), workDir });
    for (const result of [
      await absent.probe({ path: "job/in.mp4", demuxers: ["mov"] }),
      await absent.poster(posterInput),
      await absent.stampAigc(stampInput),
      await absent.health(),
    ]) {
      expect(result).toEqual({
        ok: false,
        reason: "unavailable",
        message: "mediatool 连不上（ENOENT）",
      });
    }
  });

  it("套接字的位置上有文件、但没有人在听：返回 unavailable", async () => {
    const stale = join(base, "stale.sock");
    writeFileSync(stale, "");
    const result = await createMediaToolClient({ socketPath: stale, workDir }).health();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("unavailable");
    expect(!result.ok && result.message).toMatch(/^mediatool 连不上（E[A-Z]+）$/);
  });

  it("容器不应答：到点返回 unavailable", async () => {
    reply = () => "hang";
    const impatient = createMediaToolClient({ socketPath, workDir, responseTimeoutMs: 200 });
    const started = Date.now();
    const result = await impatient.probe({ path: "job/in.mp4", demuxers: ["mov"] });
    expect(result).toEqual({
      ok: false,
      reason: "unavailable",
      message: "mediatool 在 200ms 内没有应答",
    });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("应答发到一半连接断了：返回 unavailable", async () => {
    reply = () => "drop";
    const result = await client.probe({ path: "job/in.mp4", demuxers: ["mov"] });
    expect(result).toEqual({
      ok: false,
      reason: "unavailable",
      message: "mediatool 的应答中途断开",
    });
  });

  it("容器报排队满、超时、子进程被杀、内部错误：unavailable（可以重试）；报文件解不开、路径不合规：rejected", async () => {
    const cases: Array<[number, string, "unavailable" | "rejected"]> = [
      [503, "busy", "unavailable"],
      [504, "timeout", "unavailable"],
      [503, "killed", "unavailable"],
      [500, "internal", "unavailable"],
      [422, "demux_failed", "rejected"],
      [422, "aigc_not_readable", "rejected"],
      [400, "bad_path", "rejected"],
      [404, "not_found", "rejected"],
    ];
    for (const [status, code, reason] of cases) {
      reply = () => ({ status, json: { ok: false, error: { code, message: "原因" } } });
      expect(await client.probe({ path: "job/in.mp4", demuxers: ["mov"] })).toEqual({
        ok: false,
        reason,
        message: `mediatool ${code}：原因`,
      });
    }
  });
});

describe("mediatool 调用端：入参先在本地拦", () => {
  it("带 .. 、绝对路径、隐藏文件、只有一段的路径：不发请求，直接 rejected", async () => {
    reply = () => ({ json: { ok: true, report: reportOf() } });
    const bad = [
      "../etc/passwd",
      "/etc/passwd",
      "job/../x.mp4",
      "job/.hidden",
      "in.mp4",
      "job//in.mp4",
      "",
    ];
    for (const path of bad) {
      const probed = await client.probe({ path, demuxers: ["mov"] });
      expect(probed.ok).toBe(false);
      expect(!probed.ok && probed.reason).toBe("rejected");
      expect((await client.poster({ ...posterInput, outPath: path })).ok).toBe(false);
      expect((await client.stampAigc({ ...stampInput, outPath: path })).ok).toBe(false);
    }
    expect(seen).toEqual([]);
  });

  it("解复用器不在登记的几种之内、AIGC 不是七个字段：不发请求", async () => {
    const hls = ["hls"] as unknown as ["mov"];
    expect((await client.probe({ path: "job/in.mp4", demuxers: hls })).ok).toBe(false);
    expect((await client.probe({ path: "job/in.mp4", demuxers: [] })).ok).toBe(false);
    for (const aigcJson of ["", "{}", '{"Label":"1"}', "not json", JSON.stringify([LABEL])]) {
      const result = await client.stampAigc({ ...stampInput, aigcJson });
      expect(result).toMatchObject({ ok: false, reason: "rejected" });
    }
    expect(seen).toEqual([]);
  });
});
