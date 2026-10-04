// @ts-check
// 任务书 第 7 节第 4 条：体检与封面。另核对镜像里的 ffmpeg 版本与“并发 2、其余排队”。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { audiosOf, call, fx, healthz, probe, videoOf } from "../lib/client.mjs";
import { jpegSize } from "../lib/mp4.mjs";
import { FX, MB, PORTRAIT, ROTATED } from "../lib/spec.mjs";

/**
 * @param {import("node:test").TestContext} t
 * @param {string} input
 * @param {number} atMs
 * @param {string} output
 */
async function poster(t, input, atMs, output) {
  const result = await call("POST", "/poster", {
    path: `${FX}/${input}`,
    demuxer: "mov",
    atMs,
    outPath: `${FX}/${output}`,
  });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  const bytes = readFileSync(fx(output));
  assert.equal(result.json.sizeBytes, bytes.length);
  assert.ok(bytes.length <= MB, `封面 ${bytes.length} 字节，不超过 1MB`);
  const size = jpegSize(bytes);
  assert.ok(size, "封面是合法的 JPEG（起止标记都在，读得到尺寸）");
  assert.ok(!existsSync(fx(`${output}.part`)), "没有留下半成品");
  t.diagnostic(`${output}：${size.width}×${size.height}，${bytes.length} 字节`);
  return { ...size, atMs: result.json.atMs };
}

test("服务报的 ffmpeg / ffprobe 版本就是 Dockerfile 里钉死的那个", async () => {
  const { status, json } = await healthz();
  assert.equal(status, 200);
  const expected = process.env.LYX_EXPECT_FFMPEG;
  assert.ok(expected, "编排脚本要把 Dockerfile 里的版本号经 LYX_EXPECT_FFMPEG 传进来");
  assert.equal(json.ffmpeg, expected);
  assert.equal(json.ffprobe, expected);
  assert.equal(json.limits.concurrency, 2);
});

test("probe：竖屏 H.264 + AAC 的容器、编码、显示尺寸、时长、音轨数、moov 位置", async () => {
  const { status, json } = await probe("portrait.mp4");
  assert.equal(status, 200);
  const { report } = json;
  assert.equal(report.demuxer, "mov");
  assert.match(report.format.formatName, /\bmp4\b/);
  assert.equal(report.format.majorBrand, "isom");
  assert.ok(Math.abs(report.format.durationMs - PORTRAIT.seconds * 1000) <= 50);
  const video = videoOf(report);
  assert.equal(video.codecName, "h264");
  assert.equal(video.profile, "High");
  assert.equal(video.pixFmt, "yuv420p");
  assert.equal(video.rotation, 0);
  assert.deepEqual([video.displayWidth, video.displayHeight], [PORTRAIT.width, PORTRAIT.height]);
  assert.equal(video.rFrameRate, "30/1");
  assert.equal(video.avgFrameRate, "30/1");
  assert.equal(video.nbFrames, PORTRAIT.frames);
  assert.equal(video.durationMs, PORTRAIT.seconds * 1000);
  const audios = audiosOf(report);
  assert.equal(audios.length, 1);
  assert.equal(audios[0].codecName, "aac");
  assert.equal(audios[0].sampleRate, 48000);
  assert.equal(report.moovBeforeMdat, true);
  assert.deepEqual(report.boxes.slice(0, 2), ["ftyp", "moov"]);
  assert.equal(report.aigc, null);
});

test("probe：带旋转元数据的片子按旋转后算显示尺寸", async () => {
  const { json } = await probe("rotated.mp4");
  const video = videoOf(json.report);
  assert.deepEqual([video.width, video.height], [ROTATED.width, ROTATED.height], "编码尺寸是横的");
  assert.equal(video.rotation, 90);
  assert.deepEqual([video.displayWidth, video.displayHeight], [ROTATED.height, ROTATED.width]);
  assert.equal(audiosOf(json.report).length, 1);
});

test("probe：moov 在后的片子判得出来", async () => {
  const { json } = await probe("slowstart.mp4");
  assert.equal(json.report.moovBeforeMdat, false);
  assert.ok(json.report.boxes.indexOf("mdat") < json.report.boxes.indexOf("moov"));
});

test("poster：抽第 1 秒一帧，是合法 JPEG 且不超过 1MB", async (t) => {
  const size = await poster(t, "portrait.mp4", 1000, "out-poster.jpg");
  assert.deepEqual([size.width, size.height, size.atMs], [PORTRAIT.width, PORTRAIT.height, 1000]);
});

test("poster：带旋转元数据的片子按显示方向出图", async (t) => {
  const size = await poster(t, "rotated.mp4", 1000, "out-poster-rotated.jpg");
  assert.deepEqual([size.width, size.height], [ROTATED.height, ROTATED.width]);
});

test("poster：时间点越过片尾时退回抽第一帧", async (t) => {
  const size = await poster(t, "rotated.mp4", 60_000, "out-poster-first.jpg");
  assert.equal(size.atMs, 0);
});

test("并发 2：同时发 8 个请求，同一时刻在跑的不超过 2 个，全部办成", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => probe("portrait.mp4")));
  assert.deepEqual(
    results.map((result) => result.status),
    Array(8).fill(200),
  );
  const { json } = await healthz();
  assert.ok(json.stats.peakRunning <= 2, `同时在跑的峰值 ${json.stats.peakRunning}`);
  assert.equal(json.stats.running, 0);
});
