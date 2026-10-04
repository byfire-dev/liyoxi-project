// @ts-check
// 任务书 第 7 节第 2、3 条：写后读回一致；去掉 use_metadata_tags 的反例读不回。
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { test } from "node:test";

import { call, fx, manifest, probe } from "../lib/client.mjs";
import { AIGC, AIGC_FIELDS, FX, MB, UPSTREAM_AIGC } from "../lib/spec.mjs";

/** 各流里不该因为加标而变的字段 @param {any} report */
const streamFacts = (report) =>
  report.streams.map((/** @type {any} */ s) => ({
    codecType: s.codecType,
    codecName: s.codecName,
    profile: s.profile,
    pixFmt: s.pixFmt,
    width: s.width,
    height: s.height,
    rotation: s.rotation,
    durationMs: s.durationMs,
    nbFrames: s.nbFrames,
  }));

/**
 * @param {import("node:test").TestContext} t
 * @param {string} input
 * @param {string} output
 * @param {Record<string, string>} aigc
 */
async function stampAndReadBack(t, input, output, aigc) {
  const aigcJson = JSON.stringify(aigc);
  const before = await probe(input);
  assert.equal(before.status, 200);
  assert.equal(before.json.report.aigc, null, "输入本来不带标识");

  const stamped = await call("POST", "/stampAigc", {
    path: `${FX}/${input}`,
    outPath: `${FX}/${output}`,
    aigcJson,
  });
  assert.equal(stamped.status, 200, JSON.stringify(stamped.json));

  // 另起一次 probe 读产物，不只看加标那次应答里带回来的报告
  const after = await probe(output);
  assert.equal(after.status, 200);
  const readBack = after.json.report.aigc;
  assert.equal(readBack, aigcJson, "读回的字符串与写入的逐字节相同");
  const parsed = JSON.parse(readBack);
  assert.deepEqual(Object.keys(parsed), AIGC_FIELDS, "七个字段，顺序不变");
  for (const field of AIGC_FIELDS) assert.equal(parsed[field], aigc[field], `字段 ${field}`);
  assert.equal(stamped.json.report.aigc, aigcJson, "加标应答里的回读结果也一致");

  assert.deepEqual(
    streamFacts(after.json.report),
    streamFacts(before.json.report),
    "各流的编码、时长、帧数不变",
  );
  const inputSize = statSync(fx(input)).size;
  const outputSize = statSync(fx(output)).size;
  assert.ok(
    Math.abs(outputSize - inputSize) <= MB,
    `产物大小 ${outputSize} 与输入 ${inputSize} 差在 1MB 内`,
  );
  t.diagnostic(
    `${input}：输入 ${inputSize} 字节，产物 ${outputSize} 字节，加标用了 ${stamped.ms}ms`,
  );
  assert.equal(stamped.json.inputSizeBytes, inputSize);
  assert.equal(stamped.json.outputSizeBytes, outputSize);
  assert.equal(after.json.report.moovBeforeMdat, true, "moov 在 mdat 之前");
  return { before: before.json.report, after: after.json.report, ms: stamped.ms };
}

test("stampAigc 之后 probe 读回的 AIGC 与写入的逐字段相等；流不变；大小在 ±1MB 内；moov 在 mdat 之前", async (t) => {
  const { before, after } = await stampAndReadBack(t, "slowstart.mp4", "out-stamped.mp4", AIGC);
  assert.equal(before.moovBeforeMdat, false, "这条输入的 moov 本来在后面");
  assert.ok(after.boxes.indexOf("moov") < after.boxes.indexOf("mdat"));
});

test("带旋转元数据的片子加标后旋转还在；字段里有中文也读得回", async (t) => {
  const aigc = { ...AIGC, ReservedCode1: "狸有戏 X-02 占位值" };
  const { after } = await stampAndReadBack(t, "rotated.mp4", "out-stamped-rotated.mp4", aigc);
  assert.equal(after.streams.find((/** @type {any} */ s) => s.codecType === "video").rotation, 90);
});

test("已带 AIGC 的片子：probe 读得到上游写的标识", async () => {
  const { status, json } = await probe("tagged.mp4");
  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(json.report.aigc), UPSTREAM_AIGC);
  assert.equal(manifest().controls.aigcReadableWithUseMetadataTags, true);
});

test("反例：去掉 use_metadata_tags 的加标产物读不回 AIGC", async () => {
  // stamped-no-umt.mp4 由造片脚本直接用 ffmpeg 加标，-movflags 里只有 +faststart
  const { status, json } = await probe("stamped-no-umt.mp4");
  assert.equal(status, 200);
  assert.equal(json.report.aigc, null, "读不回");
  const keys = Object.keys(json.report.format.tags).map((key) => key.toLowerCase());
  assert.ok(!keys.includes("aigc"), `容器级标签里没有 AIGC：${keys.join("、")}`);
  // 对照：造片时直接用 ffprobe 读，同样读不回
  assert.equal(manifest().controls.aigcDroppedWithoutUseMetadataTags, true);
  // 对照：已带标识的片子做一次普通的流拷贝重封装（不带 -metadata，也不带 use_metadata_tags），标识同样丢掉。
  // 所以凡是经过重封装或转码的产物，都要显式补写并回读（03 第 7.4 节）
  assert.equal(manifest().controls.aigcDroppedByPlainRemux, true);
});

test("已知限制：带时间码轨的 mov 按 -map 0 流拷贝成 mp4 会失败，报 remux_failed，不留产物", async () => {
  const probed = await probe("timecode.mov");
  assert.equal(probed.status, 200);
  const kinds = probed.json.report.streams.map((/** @type {any} */ s) => s.codecType);
  assert.deepEqual(kinds, ["video", "data"], "除视频外还有一条数据轨（tmcd）");
  const stamped = await call("POST", "/stampAigc", {
    path: `${FX}/timecode.mov`,
    outPath: `${FX}/out-timecode.mp4`,
    aigcJson: JSON.stringify(AIGC),
  });
  assert.equal(stamped.status, 422);
  assert.equal(stamped.json.error.code, "remux_failed");
  assert.ok(!existsSync(fx("out-timecode.mp4")) && !existsSync(fx("out-timecode.mp4.part")));
});

test("加标的入参不合规即拒绝：不是字符串、超长、带换行；输出与输入同名", async () => {
  const base = { path: `${FX}/portrait.mp4`, outPath: `${FX}/out-bad.mp4` };
  for (const aigcJson of [undefined, { Label: "1" }, "x".repeat(2049), '{"Label":"1"}\n-map 0']) {
    const { status, json } = await call("POST", "/stampAigc", { ...base, aigcJson });
    assert.equal(status, 400);
    assert.equal(json.error.code, "bad_request");
  }
  const same = await call("POST", "/stampAigc", {
    path: base.path,
    outPath: base.path,
    aigcJson: JSON.stringify(AIGC),
  });
  assert.equal(same.status, 400);
  assert.equal(same.json.error.code, "bad_path");
});
