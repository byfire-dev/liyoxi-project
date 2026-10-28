// @ts-check
// 真正视频重编码与固定字体叠印；不以数据库标志代替产物。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { audiosOf, call, fx, videoOf } from "../lib/client.mjs";
import { FX } from "../lib/spec.mjs";

const text = "样片 · 仅供「演示门店」确认 · 10-27";
test("真实中心水印视频保持1080×1920与AAC并可回读faststart，源文件不变", async () => {
  const path = `${FX}/watermark-source.mp4`,
    outPath = `${FX}/watermark-preview.mp4`;
  const before = createHash("sha256")
    .update(readFileSync(fx("watermark-source.mp4")))
    .digest("hex");
  const result = await call("POST", "/watermarkSample", { path, outPath, text });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  const report = result.json.report,
    video = videoOf(report);
  assert.deepEqual([video.displayWidth, video.displayHeight, video.rotation], [1080, 1920, 0]);
  assert.deepEqual([video.codecName, video.profile, video.pixFmt], ["h264", "High", "yuv420p"]);
  assert.equal(audiosOf(report).length, 1);
  assert.equal(audiosOf(report)[0].codecName, "aac");
  assert.equal(report.moovBeforeMdat, true);
  assert.equal(report.aigc, null, "不得生成虚假AI主体标识");
  assert.equal(report.format.tags.comment, undefined, "不传播原文件的无关元数据");
  assert.equal(result.json.outputSizeBytes, statSync(fx("watermark-preview.mp4")).size);
  assert.equal(result.json.inputSizeBytes, statSync(fx("watermark-source.mp4")).size);
  assert.equal(
    createHash("sha256")
      .update(readFileSync(fx("watermark-source.mp4")))
      .digest("hex"),
    before,
  );
  for (const [name, source] of [
    ["watermark-before.jpg", path],
    ["watermark-after.jpg", outPath],
  ]) {
    const poster = await call("POST", "/poster", {
      path: source,
      demuxer: "mov",
      atMs: 0,
      outPath: `${FX}/${name}`,
    });
    assert.equal(poster.status, 200, JSON.stringify(poster.json));
  }
  assert.ok(
    statSync(fx("watermark-after.jpg")).size > statSync(fx("watermark-before.jpg")).size + 500,
    "纯黑视频实际产生可见文字细节，而非只改容器元数据",
  );
  assert.equal(existsSync(fx("watermark-preview.mp4.part")), false);
});

test("视频水印拒绝越界、任意filter及非法文案，不产生伪成功产物", async () => {
  for (const extra of [
    { outPath: "../stolen.mp4" },
    { text: `${text}\n` },
    { filter: "movie=http://external.invalid" },
  ]) {
    const result = await call("POST", "/watermarkSample", {
      path: `${FX}/watermark-source.mp4`,
      outPath: `${FX}/watermark-invalid.mp4`,
      text,
      ...extra,
    });
    assert.ok(result.status >= 400 && result.status < 500, JSON.stringify(result));
    assert.equal(result.json.ok, false);
    assert.equal(existsSync(fx("watermark-invalid.mp4")), false);
  }
});
