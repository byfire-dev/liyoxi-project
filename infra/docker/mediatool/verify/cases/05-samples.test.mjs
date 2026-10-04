// @ts-check
// 任务书 第 8 节：业主给的验证用样片（E17）。放在仓库之外的 ~/.lyx/samples/x02/；目录存在时自动加测，
// 不存在就跳过并在报告里注明。样片不入库，这里只打印体检摘要与加标回读的结果。
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { call, manifest } from "../lib/client.mjs";
import { AIGC, MB, WORK } from "../lib/spec.mjs";

test("业主给的样片：体检；不带标识的加标并读回一致", async (t) => {
  const { samples } = manifest();
  if (samples.length === 0) {
    t.skip("没有样片：~/.lyx/samples/x02/ 不存在或是空的，本次只用自制测试片");
    return;
  }
  for (const { file, original } of samples) {
    const path = `samples/${file}`;
    const probed = await call("POST", "/probe", { path, demuxers: ["mov"] });
    assert.equal(probed.status, 200, `${original}：${JSON.stringify(probed.json)}`);
    const { report } = probed.json;
    const video = report.streams.find((/** @type {any} */ s) => s.codecType === "video");
    t.diagnostic(
      `${original}：${video?.codecName} ${video?.displayWidth}×${video?.displayHeight}，${report.format.durationMs}ms，` +
        `${report.format.sizeBytes} 字节，moov 在前 ${report.moovBeforeMdat}，已带标识 ${report.aigc !== null}`,
    );
    if (report.aigc !== null) continue; // 上游已经写了标识：原样保留，不覆盖（D5 第 12.1 节）
    const aigcJson = JSON.stringify(AIGC);
    const outPath = `samples/out-${file.replace(/\.\w+$/, "")}.mp4`;
    const stamped = await call("POST", "/stampAigc", { path, outPath, aigcJson });
    assert.equal(stamped.status, 200, `${original}：${JSON.stringify(stamped.json)}`);
    const after = await call("POST", "/probe", { path: outPath, demuxers: ["mov"] });
    assert.equal(after.json.report.aigc, aigcJson, `${original}：读回一致`);
    assert.equal(
      after.json.report.streams.length,
      report.streams.length,
      `${original}：流的条数不变`,
    );
    const delta = statSync(join(WORK, outPath)).size - statSync(join(WORK, path)).size;
    assert.ok(Math.abs(delta) <= MB, `${original}：大小差 ${delta} 字节`);
  }
});
