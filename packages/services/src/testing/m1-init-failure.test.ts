import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { expect, it } from "vitest";

const packageDirectory = fileURLToPath(new URL("../../", import.meta.url));
const loader = createRequire(import.meta.url).resolve("tsx");

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("没有随机 TCP 端口");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

// 普通 Node/tsx 子进程，不继承 VITEST 或测试 shim。保护时限只负责失败时回收本测试的子进程。
async function attempt(redisUrl: string, runId: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      loader,
      "--input-type=module",
      "--eval",
      `import { createM1Support } from '@liyoxi/services/testing';
       try {
         const support = await createM1Support({ runId: ${JSON.stringify(runId)} });
         await support.close();
         process.stdout.write('unexpected-success');
         process.exitCode = 2;
       } catch {
         process.stdout.write('caught-rejection');
         process.exitCode = 1;
       }`,
    ],
    {
      cwd: packageDirectory,
      env: {
        PATH: process.env.PATH,
        APP_ENV: "test",
        DATABASE_URL: "postgresql://liyoxi:lyx-local-dev@127.0.0.1:5442/liyoxi",
        REDIS_URL: redisUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (bytes: Buffer) => (output += bytes.toString()));
  child.stderr.on("data", (bytes: Buffer) => (stderr += bytes.toString()));
  return new Promise<{
    code: number | null;
    signal: string | null;
    output: string;
    stderr: string;
    timedOut: boolean;
  }>((resolve, reject) => {
    const guard = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(guard);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, output, stderr, timedOut });
    });
  });
}

it("Redis 连接拒绝后公开 testing 入口捕获错误并自然非零退出", async () => {
  const port = await unusedLoopbackPort();
  const result = await attempt(`redis://127.0.0.1:${port}/0`, randomBytes(6).toString("hex"));
  expect(result.output).toBe("caught-rejection");
  expect(result.timedOut).toBe(false);
  expect(result.signal).toBeNull();
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("");
}, 15_000);

it.each([true, false])(
  "初始化失败保留既有 scope 数据（owner 冲突=%s）",
  async (hasOwner) => {
    const redisUrl = "redis://127.0.0.1:6389/0";
    const runId = randomBytes(6).toString("hex");
    const ownerKey = `lyx:test:${runId}:0:m1.owner`;
    const sentinelKey = `lyx:test:${runId}:0:previous.sentinel`;
    const redis = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 1000,
      maxRetriesPerRequest: 1,
    });
    redis.on("error", () => undefined);
    try {
      await redis.connect();
      await redis.set(sentinelKey, "previous-data");
      if (hasOwner) await redis.set(ownerKey, "previous-owner");
      const result = await attempt(redisUrl, runId);
      expect(result.output).toBe("caught-rejection");
      expect(result.timedOut).toBe(false);
      expect(result.signal).toBeNull();
      expect(result.code).toBe(1);
      expect(await redis.get(sentinelKey)).toBe("previous-data");
      expect(await redis.get(ownerKey)).toBe(hasOwner ? "previous-owner" : null);
    } finally {
      // 仅删除本测试显式创建的两个随机键，既有共享数据不在清理集合中。
      try {
        await redis.unlink(ownerKey, sentinelKey);
      } finally {
        redis.disconnect();
      }
    }
  },
  15_000,
);
