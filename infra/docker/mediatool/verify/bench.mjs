// @ts-check
// 任务书 第 7 节第 8 条：约 200MB 的测试片“体检 + 封面”合计不超过 10 秒（D5 第 16 节 P9，本地不含下载）；
// stampAigc 的耗时只记录，没有硬线。在 caller 容器里跑，耗时是调用端看到的整次调用（含排队与套接字往返）。
import assert from "node:assert/strict";
import { rmSync, statSync } from "node:fs";

import { call, fx, healthz, manifest, probe } from "./lib/client.mjs";
import { AIGC, FX, MB } from "./lib/spec.mjs";

const LIMIT_MS = 10_000;
const ROUNDS = 5;
const STAMP_ROUNDS = 3;
const INPUT = "big.mp4";

/** @param {number[]} values */
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) };
};

const sizeBytes = statSync(fx(INPUT)).size;
const health = (await healthz()).json;

/** @type {{ probeMs: number, posterMs: number, totalMs: number }[]} */
const rounds = [];
for (let round = 0; round < ROUNDS; round += 1) {
  const probed = await probe(INPUT);
  assert.equal(probed.status, 200, JSON.stringify(probed.json));
  const drawn = await call("POST", "/poster", {
    path: `${FX}/${INPUT}`,
    demuxer: "mov",
    atMs: 1000,
    outPath: `${FX}/out-bench.jpg`,
  });
  assert.equal(drawn.status, 200, JSON.stringify(drawn.json));
  rounds.push({ probeMs: probed.ms, posterMs: drawn.ms, totalMs: probed.ms + drawn.ms });
}

/** @type {number[]} */
const stampMs = [];
for (let round = 0; round < STAMP_ROUNDS; round += 1) {
  const stamped = await call("POST", "/stampAigc", {
    path: `${FX}/${INPUT}`,
    outPath: `${FX}/out-bench.mp4`,
    aigcJson: JSON.stringify(AIGC),
  });
  assert.equal(stamped.status, 200, JSON.stringify(stamped.json));
  assert.equal(stamped.json.report.aigc, JSON.stringify(AIGC));
  assert.ok(Math.abs(stamped.json.outputSizeBytes - sizeBytes) <= MB);
  stampMs.push(stamped.ms);
  rmSync(fx("out-bench.mp4"));
}

const probePoster = summary(rounds.map((round) => round.totalMs));
const report = {
  ffmpeg: health.ffmpeg,
  fixtureFfmpeg: manifest().ffmpeg,
  input: { file: INPUT, sizeBytes, sizeMB: Number((sizeBytes / MB).toFixed(1)) },
  limits: { concurrency: health.limits.concurrency, cpus: 1, memory: "1GB" },
  rounds,
  probePosterMs: probePoster,
  probeMs: summary(rounds.map((round) => round.probeMs)),
  posterMs: summary(rounds.map((round) => round.posterMs)),
  stampAigcMs: summary(stampMs),
  limitMs: LIMIT_MS,
  // 按最慢的一轮判
  pass: Number(probePoster.max) <= LIMIT_MS,
};

console.log(`测试片 ${report.input.sizeMB}MB；ffmpeg ${report.ffmpeg}；mediatool 限 1 核、1GB`);
console.log("轮次  体检ms  封面ms  合计ms");
rounds.forEach((round, index) => {
  console.log(`${index + 1}     ${round.probeMs}     ${round.posterMs}     ${round.totalMs}`);
});
console.log(
  `体检 + 封面：最快 ${probePoster.min}ms，中位 ${probePoster.median}ms，最慢 ${probePoster.max}ms（线：${LIMIT_MS}ms）`,
);
console.log(`stampAigc（含回读）：${stampMs.join("ms、")}ms（没有硬线）`);
console.log(`LYX-BENCH-REPORT ${JSON.stringify(report)}`);
console.log(report.pass ? "耗时：通过" : "耗时：不通过");
process.exit(report.pass ? 0 : 1);
