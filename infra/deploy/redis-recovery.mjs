// @ts-check
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

export const RECOVERY_LIMIT_MS = 120_000;
export const LOG_ROTATION = Object.freeze({
  postgres: { size: "10m", files: "3", mib: 30 },
  redis: { size: "10m", files: "3", mib: 30 },
  mediatool: { size: "10m", files: "3", mib: 30 },
  api: { size: "20m", files: "5", mib: 100 },
  worker: { size: "20m", files: "5", mib: 100 },
  gateway: { size: "20m", files: "5", mib: 100 },
});

/** @typedef {{container:{id:string,pid:number,restarts:number,startedAt:string,running:boolean},lease:{holder:string,acquiredAt:string,heartbeatAt:string,ageSeconds:number},event:{publishedAt:string|null,deliveries:{subscriber:string,status:string,consumedAt:string|null}[]},timer:{status:string,firedAt:string|null,result:unknown}}} RecoveryFacts */
/**
 * 只接受具体事件/任务的完成事实；单靠心跳或零积压不算恢复。时限包含最后一次读取。
 * @param {{before:RecoveryFacts,flushedAt:number,subscribers:string[],read:(remainingMs:number)=>Promise<RecoveryFacts>,now?:()=>number,sleep?:(ms:number)=>Promise<unknown>}} options
 */
export async function waitForRedisRecovery(options) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const baseline = options.before;
  const expected = [...options.subscribers].sort();
  if (
    !expected.length ||
    new Set(expected).size !== expected.length ||
    !baseline.container.running ||
    baseline.container.pid <= 0 ||
    !baseline.lease.holder ||
    !Number.isFinite(baseline.lease.ageSeconds) ||
    baseline.lease.ageSeconds < 0 ||
    baseline.lease.ageSeconds >= 30 ||
    !Number.isFinite(Date.parse(baseline.lease.heartbeatAt)) ||
    !Number.isFinite(options.flushedAt)
  )
    throw new Error("恢复演练缺少有效基线");
  for (;;) {
    if (now() - options.flushedAt >= RECOVERY_LIMIT_MS) throw new Error("Redis 恢复超过 120 秒");
    const facts = await options.read(RECOVERY_LIMIT_MS - (now() - options.flushedAt));
    const elapsedMs = now() - options.flushedAt;
    if (elapsedMs >= RECOVERY_LIMIT_MS) throw new Error("Redis 恢复超过 120 秒");
    if (
      !facts.container.running ||
      facts.container.id !== baseline.container.id ||
      facts.container.pid !== baseline.container.pid ||
      facts.container.restarts !== baseline.container.restarts ||
      facts.container.startedAt !== baseline.container.startedAt ||
      facts.lease.holder !== baseline.lease.holder ||
      facts.lease.acquiredAt !== baseline.lease.acquiredAt ||
      !Number.isFinite(facts.lease.ageSeconds) ||
      facts.lease.ageSeconds < 0 ||
      facts.lease.ageSeconds >= 30
    )
      throw new Error("worker 重启、换主或租约不连续，不能作为自愈证据");
    const afterFlush = (/** @type {string|null} */ value) =>
      value !== null &&
      Number.isFinite(Date.parse(value)) &&
      Date.parse(value) >= options.flushedAt;
    const delivered = facts.event.deliveries;
    if (
      Date.parse(facts.lease.heartbeatAt) > Date.parse(baseline.lease.heartbeatAt) &&
      afterFlush(facts.lease.heartbeatAt) &&
      afterFlush(facts.event.publishedAt) &&
      JSON.stringify(delivered.map((row) => row.subscriber).sort()) === JSON.stringify(expected) &&
      delivered.every((row) => row.status === "done" && afterFlush(row.consumedAt)) &&
      facts.timer.status === "fired" &&
      afterFlush(facts.timer.firedAt) &&
      facts.timer.result !== null
    )
      return {
        elapsedMs,
        worker: facts.container,
        lease: facts.lease,
        subscribers: expected,
        timer: facts.timer,
      };
    await sleep(Math.min(2_000, RECOVERY_LIMIT_MS - elapsedMs));
  }
}

/** @param {string} root @param {string} outFile */
export async function buildRecoveryFixture(root, outFile) {
  // 工具和外置包沿现有 worker 构建；只产出一个临时 helper，不构建镜像或正式 worker。
  const { build } = createRequire(join(root, "apps/worker/package.json"))("esbuild");
  await build({
    absWorkingDir: root,
    entryPoints: ["infra/deploy/redis-recovery-fixture.mjs"],
    outfile: outFile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    external: [
      "bullmq",
      "ioredis",
      "mammoth",
      "sanitize-html",
      "pdfjs-dist",
      "@napi-rs/canvas",
      "tencentcloud-sdk-nodejs-ocr",
    ],
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    logLevel: "silent",
  });
}

/** 开启一个有界的事实持锁进程；任何失败/超时都会终止并释放其数据库连接。
 * @param {string[]} args @param {NodeJS.ProcessEnv} env
 */
export async function holdRecoveryFixture(args, env) {
  const child = spawn("docker", args, { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {}); // 提前退出由 closed 的非零结果判定；EPIPE 不得跳过外层清理。
  const lines = createInterface({ input: child.stdout });
  const closed = new Promise((resolve) => child.once("close", (code) => resolve(code)));
  let ended = false;
  const stop = () => {
    if (!ended) child.kill("SIGKILL");
  };
  const timer = setTimeout(stop, 30_000);
  child.stderr.resume(); // 失败只给固定类别，绝不把容器内部错误原文带回日志。
  try {
    const raw = await new Promise((resolve, reject) => {
      lines.once("line", resolve);
      child.once("error", () => reject(new Error("演练助手未启动")));
      child.once("close", () => reject(new Error("演练助手没有返回已提交事实")));
    });
    const value = JSON.parse(String(raw));
    if (
      !/^[a-f0-9-]{36}$/.test(value.eventId) ||
      !/^[a-f0-9-]{36}$/.test(value.timerId) ||
      !Array.isArray(value.subscribers) ||
      !value.subscribers.length ||
      !value.subscribers.every(
        (/** @type {unknown} */ name) =>
          typeof name === "string" && /^[a-zA-Z][a-zA-Z0-9_.]+$/.test(name),
      )
    )
      throw new Error("演练助手返回事实不完整");
    return {
      ...value,
      async release() {
        child.stdin.end("release\n");
        if ((await closed) !== 0) throw new Error("演练事实持锁未正常释放");
        ended = true;
        clearTimeout(timer);
        lines.close();
      },
      async close() {
        stop();
        await closed;
        ended = true;
        clearTimeout(timer);
        lines.close();
      },
    };
  } catch {
    stop();
    await closed;
    clearTimeout(timer);
    lines.close();
    throw new Error("Redis 恢复演练事实准备失败");
  }
}
