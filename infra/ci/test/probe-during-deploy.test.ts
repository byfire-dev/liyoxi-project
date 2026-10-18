import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkTargets, probe, validateTargets } from "../probe-during-deploy.mjs";
import { makeTempDir, repoRoot } from "./helpers.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function server(handler: http.RequestListener) {
  const app = http.createServer(handler);
  await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        app.closeAllConnections();
        app.close(() => done());
      }),
  );
  const address = app.address();
  if (!address || typeof address === "string") throw new Error("没有端口");
  return `http://127.0.0.1:${address.port}`;
}

describe("发布中的真实 HTTP 连续探测", () => {
  it("每秒采样：实际 2.4 秒故障的中断误差小于一秒，JSON 保留失败数与恢复时刻", async () => {
    const dir = makeTempDir("lyx-deploy-probe-");
    cleanups.push(dir.cleanup);
    const started = Date.now();
    const base = await server((_req, res) => {
      const elapsed = Date.now() - started;
      res.statusCode = elapsed >= 1100 && elapsed < 3500 ? 503 : 200;
      res.end("health");
    });
    const output = join(dir.dir, "probe.json");
    const report = await probe({
      targets: [{ name: "api", url: `${base}/readyz` }],
      output,
      durationMs: 5000,
    });
    expect(report.intervalMs).toBe(1000);
    expect(report.rounds).toBeGreaterThanOrEqual(5);
    expect(report.requests).toBe(report.rounds);
    expect(report.failures).toBe(2);
    expect(report.targets[0]!.outages).toHaveLength(1);
    expect(report.targets[0]!.outages[0]!.ongoing).toBe(false);
    expect(Math.abs(report.targets[0]!.interruptionMs - 2400)).toBeLessThanOrEqual(1000);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(report);
    expect(report.finishedAt).not.toBeNull();
  });
  it("全资源检查识别 404、SPA 200 错内容与正确文件；不把入口 200 当资源完整", async () => {
    const base = await server((req, res) => {
      res.statusCode = req.url === "/missing.js" ? 404 : 200;
      res.end(req.url === "/ok.js" ? "chunk" : "<html>fallback</html>");
    });
    const digest = createHash("sha256").update("chunk").digest("hex");
    const errors = await checkTargets([
      { name: "ok", url: `${base}/ok.js`, sha256: digest },
      { name: "missing", url: `${base}/missing.js`, sha256: digest },
      { name: "fallback", url: `${base}/fallback.js`, sha256: digest },
    ]);
    expect(errors.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "fallback", error: "sha256 不符" },
      { name: "missing", error: "HTTP 404" },
    ]);
  });
  it("真 CLI 收 SIGTERM 仍保存完整 JSON，未恢复故障标 ongoing", async () => {
    const dir = makeTempDir("lyx-deploy-probe-signal-");
    cleanups.push(dir.cleanup);
    const base = await server((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const config = join(dir.dir, "config.json"),
      output = join(dir.dir, "probe.json");
    writeFileSync(config, JSON.stringify([{ name: "admin/asset", url: `${base}/missing.js` }]));
    const child = spawn(process.execPath, [
      join(repoRoot, "infra/ci/probe-during-deploy.mjs"),
      "--config",
      config,
      "--output",
      output,
    ]);
    cleanups.push(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    const ended = new Promise<number | null>((done) => child.once("exit", done));
    await new Promise<void>((done, reject) => {
      child.stdout.on("data", (data: Buffer) => {
        if (data.toString().includes("LYX_PROBE_READY")) done();
      });
      child.once("error", reject);
    });
    await new Promise((done) => setTimeout(done, 1100));
    child.kill("SIGTERM");
    expect(await ended).toBe(0);
    const report = JSON.parse(readFileSync(output, "utf8"));
    expect(report.finishedAt).toEqual(expect.any(String));
    expect(report.failures).toBeGreaterThan(0);
    expect(report.targets[0].outages[0]).toMatchObject({ ongoing: true, error: "HTTP 404" });
  });
  it("拒绝凭证、重名、Host 注入与非法摘要", () => {
    for (const value of [
      [],
      [{ name: "x", url: "http://u:p@localhost/" }],
      [{ name: "x", url: "http://localhost", host: "x\r\nAuthorization: p" }],
      [{ name: "x", url: "http://localhost", sha256: "bad" }],
      [
        { name: "x", url: "http://localhost" },
        { name: "x", url: "http://localhost" },
      ],
    ])
      expect(() => validateTargets(value)).toThrow();
  });
});

describe("编排 CLI 与独立探测进程", () => {
  it("真实子进程穿过失败步骤仍收完整探测摘要，原始失败与节点记录不被覆盖", async () => {
    const dir = makeTempDir("lyx-orchestrate-monitor-");
    cleanups.push(dir.cleanup);
    const base = await server((_req, res) => res.end("healthy"));
    const config = join(dir.dir, "probe-config.json"),
      output = join(dir.dir, "probe.json"),
      summary = join(dir.dir, "summary.json");
    writeFileSync(config, JSON.stringify([{ name: "api", url: base }]));
    const bash = `#!/bin/bash
while [ "$1" != -- ]; do shift; done
shift; shift
case "$1" in
 facts) printf 'LYX_CURRENT=sha-111111111111\\n' ;;
 preflight) printf 'LYX_PREFLIGHT={"p1":"unavailable","ids":[]}\\n' ;;
 image-facts) for one in server gateway mediatool; do printf 'LYX_IMAGE=%s|sha256:%064d\\n' "$one" 0; done ;;
 api-start) printf '原始失败\\n' >&2; exit 17 ;;
esac
`;
    const { chmodSync } = await import("node:fs");
    writeFileSync(join(dir.dir, "ssh"), bash);
    chmodSync(join(dir.dir, "ssh"), 0o755);
    const child = spawn(
      process.execPath,
      [
        join(repoRoot, "infra/deploy/orchestrate.mjs"),
        "--tag",
        "sha-222222222222",
        "--compat-result",
        "passed",
        "--node",
        "deploy@fixture.invalid",
        "--probe-config",
        config,
        "--probe-summary",
        output,
        "--summary",
        summary,
      ],
      { env: { ...process.env, STG_FREEZE: "false", PATH: `${dir.dir}:${process.env.PATH}` } },
    );
    child.stdout.resume();
    child.stderr.resume();
    const exit = await new Promise<number | null>((done, reject) => {
      child.once("exit", done);
      child.once("error", reject);
    });
    expect(exit).toBe(1);
    const report = JSON.parse(readFileSync(summary, "utf8"));
    expect(report).toMatchObject({
      compatibility: "passed",
      failedStep: "api-start",
      onlineTouched: true,
      recordError: "",
      probeStatus: "recorded",
      probeError: "",
    });
    expect(report.error).toContain("原始失败");
    expect(report.probe.finishedAt).toEqual(expect.any(String));
    expect(report.probe.rounds).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(report.probe);
  });
});
