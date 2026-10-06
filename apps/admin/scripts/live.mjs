#!/usr/bin/env node
// W1-02①：真实 api 构建产物 + 生产后台静态文件，与 /api 同源转发。
// 只用 Node 与现有 CLI：前端不 import services/db，不读写 .env。
// 所有服务端造数文件由 admin:live:data 在一个进程依次执行；后续页面包只加登记文件和 live-*.spec.ts。
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ADMIN = join(ROOT, "apps/admin");
const id = randomBytes(8).toString("hex");
const name = `lyx_test_admin_live_${id}`;
const prefix = `lyx:test:admin_live_${id}:`;
const apiOut = `dist/admin-live-${id}`;
const appOut = `dist/admin-live-${id}`;
const temporary = join(ADMIN, "dist/tmp", `admin-live-${id}`);
const contextFile = join(temporary, "context.json");
const stateFile = join(temporary, "state.json");
const apiLog = join(ADMIN, "dist/e2e-live-logs", `api-${id}.log`);
const children = new Set();
const cleanupChildren = new WeakSet();
let interrupted = false;
let databaseRequested = false;
let proxy;

// 不继承真实服务配置/密钥路径；CLI 只收到运行工具所需的进程环境与下面现造的测试配置。
const processKeys = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "CI",
  "GITHUB_ACTIONS",
  "PNPM_HOME",
  "PLAYWRIGHT_BROWSERS_PATH",
  "LYX_E2E_CHANNEL",
  "NPM_CONFIG_ENGINE_STRICT",
];
const toolEnv = Object.fromEntries(
  processKeys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
);
function localUrl(key, protocols) {
  const value = process.env[key];
  if (!value) throw new Error(`${key} 未设置：使用本地 Compose 的公开测试连接参数`);
  const url = new URL(value);
  if (
    !protocols.includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error(`${key} 只允许本机测试服务`);
  return url;
}
function terminate(child, signal = "SIGTERM") {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
function spawnOwn(command, args, env, cwd = ROOT, cleanup = false) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  if (cleanup) cleanupChildren.add(child);
  child.once("close", () => children.delete(child));
  return child;
}
function run(command, args, env, { capture = false, cwd = ROOT, cleanup = false } = {}) {
  if (interrupted && !cleanup) return Promise.reject(new Error("验收已被中断"));
  return new Promise((accept, reject) => {
    const child = spawnOwn(command, args, env, cwd, cleanup);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      if (capture) stdout += chunk;
      else process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
      if (!capture) process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) accept(stdout);
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} 失败（${signal ?? code}）${capture ? `：${stderr.trim()}` : ""}`,
          ),
        );
    });
  });
}
async function stopChildren() {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise((accept) => {
          const timer = setTimeout(() => {
            terminate(child, "SIGKILL");
          }, 10_000);
          child.once("close", () => {
            clearTimeout(timer);
            accept();
          });
          terminate(child);
        }),
    ),
  );
}
function startApi(env) {
  return new Promise((accept, reject) => {
    const child = spawnOwn(
      process.execPath,
      [
        join(ROOT, "apps/api", apiOut, "server.js"),
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--test-redis-prefix",
        prefix,
      ],
      env,
    );
    const log = createWriteStream(apiLog);
    let buffered = "";
    const timer = setTimeout(() => reject(new Error(`api 启动超过 60 秒；查看 ${apiLog}`)), 60_000);
    const fail = () => {
      clearTimeout(timer);
      reject(new Error(`api 启动失败；查看 ${apiLog}`));
    };
    child.once("error", fail);
    child.once("close", fail);
    child.stderr.on("data", (chunk) => log.write(chunk));
    child.stdout.on("data", (chunk) => {
      log.write(chunk);
      buffered += chunk;
      let at;
      while ((at = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.evt === "api.listening" && Number.isInteger(entry.port) && entry.port > 0) {
          clearTimeout(timer);
          child.off("close", fail);
          accept(`http://127.0.0.1:${entry.port}`);
        }
      }
    });
    child.once("close", () => log.end());
  });
}
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};
async function serveProduction(apiOrigin) {
  const directory = join(ADMIN, appOut);
  proxy = createServer((incoming, response) => {
    const requested = new URL(incoming.url ?? "/", "http://localhost");
    const pathname = requested.pathname;
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      // 保留浏览器 Host 与 Origin（包括端口）：后台 C4 的同源门禁仍由真实 api 判定。
      const target = new URL(apiOrigin);
      target.pathname = pathname;
      target.search = requested.search;
      const upstream = httpRequest(
        target,
        { method: incoming.method, headers: incoming.headers },
        (result) => {
          response.writeHead(result.statusCode ?? 502, result.headers);
          result.pipe(response);
        },
      );
      upstream.on("error", () => {
        response.writeHead(502);
        response.end("测试 API 不可用");
      });
      incoming.pipe(upstream);
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    let target;
    try {
      target = resolve(directory, `.${decodeURIComponent(pathname)}`);
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    if (target !== directory && !target.startsWith(`${directory}${sep}`)) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (!extname(pathname)) target = join(directory, "index.html");
    if (!existsSync(target) || target === directory) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME[extname(target)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    const stream = createReadStream(target);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  });
  await new Promise((accept, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", accept);
  });
  return `http://127.0.0.1:${proxy.address().port}`;
}
function writeFakeKeys() {
  const b64 = (byte) => Buffer.alloc(32, byte).toString("base64");
  const files = {
    DATA_KEYS_FILE: { current: "test", keys: { test: b64(0x51) } },
    BIDX_KEYS_FILE: { phone: b64(0x52), uscc: b64(0x53) },
    AUTH_KEYS_FILE: {
      ticket: b64(0x71),
      device: b64(0x72),
      mfa: { current: "t1", keys: { t1: b64(0x73) } },
    },
  };
  return Object.fromEntries(
    Object.entries(files).map(([key, value]) => {
      const path = join(temporary, `${key}.json`);
      writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      return [key, path];
    }),
  );
}
async function main() {
  if (!/^(24|26)\./.test(process.versions.node))
    throw new Error("真实后台验收需要 Node 24，或仓库夜间兼容检查使用的 Node 26");
  if (process.env.APP_ENV && process.env.APP_ENV !== "test")
    throw new Error("真实后台验收只允许 APP_ENV=test");
  const originalDatabase = localUrl("DATABASE_URL", ["postgresql:", "postgres:"]);
  const redis = localUrl("REDIS_URL", ["redis:", "rediss:"]);
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(apiLog), { recursive: true });
  const baseEnv = {
    ...toolEnv,
    APP_ENV: "test",
    DATABASE_URL: originalDatabase.toString(),
    REDIS_URL: redis.toString(),
    LOG_LEVEL: "info",
    LYX_BUILD: `admin-live-${id}`,
    LYX_TEST_SESSION: id.slice(0, 12),
    ...writeFakeKeys(),
  };
  const database = new URL(originalDatabase);
  database.pathname = `/${name}`;
  database.search = "";
  database.searchParams.set("options", "-c role=lyx_app");
  const testEnv = { ...baseEnv, DATABASE_URL: database.toString() };
  try {
    console.log(`真实后台验收：独立库 ${name}，专属前缀 ${prefix}`);
    databaseRequested = true;
    await run("pnpm", ["test:db:seeded", "--name", name], baseEnv);
    const bootstrap = await run(
      "pnpm",
      ["staff:bootstrap", "--name", "验收管理员", "--phone", "13800138001"],
      testEnv,
      { capture: true },
    );
    const activationCode = /激活码：([A-Z0-9]{8})/.exec(bootstrap)?.[1];
    if (!activationCode) throw new Error("staff:bootstrap 没有返回激活码");
    const fixturesOutput = await run(
      "pnpm",
      [
        "--silent",
        "--filter",
        "@liyoxi/services",
        "admin:live:data",
        "--name",
        name,
        "--test-redis-prefix",
        prefix,
      ],
      testEnv,
      { capture: true },
    );
    const fixtures = JSON.parse(fixturesOutput);
    await run("pnpm", ["--filter", "@liyoxi/api", "build", "--outdir", apiOut], testEnv);
    await run(
      "pnpm",
      [
        "--filter",
        "@liyoxi/admin",
        "exec",
        "vite",
        "build",
        "--mode",
        "production",
        "--outDir",
        appOut,
      ],
      baseEnv,
    );
    await run(process.execPath, ["scripts/check-build.mjs", appOut, "--app", "admin"], baseEnv, {
      cwd: ADMIN,
    });
    const apiOrigin = await startApi(testEnv);
    if (!(await fetch(`${apiOrigin}/readyz`)).ok) throw new Error("api 尚未就绪");
    const origin = await serveProduction(apiOrigin);
    writeFileSync(
      contextFile,
      `${JSON.stringify({ origin, name: "验收管理员", phone: "13800138001", password: "Liyoxi-2026-ok", activationCode, storageState: stateFile, fixtures })}\n`,
      { mode: 0o600 },
    );
    await run(
      "pnpm",
      ["--filter", "@liyoxi/admin", "exec", "playwright", "test", "--project", "live"],
      {
        ...toolEnv,
        LYX_ADMIN_LIVE: "1",
        LYX_ADMIN_LIVE_ORIGIN: origin,
        LYX_ADMIN_LIVE_CONTEXT: contextFile,
        LYX_ADMIN_LIVE_STATE: stateFile,
      },
    );
  } finally {
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise((accept) => proxy.close(accept));
    }
    await stopChildren();
    try {
      if (databaseRequested)
        await run(
          "pnpm",
          [
            "--silent",
            "--filter",
            "@liyoxi/services",
            "admin:live:data",
            "--cleanup",
            "--name",
            name,
            "--test-redis-prefix",
            prefix,
          ],
          baseEnv,
          { cleanup: true },
        );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
      rmSync(join(ROOT, "apps/api", apiOut), { recursive: true, force: true });
      rmSync(join(ADMIN, appOut), { recursive: true, force: true });
    }
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    interrupted = true;
    // 清理一旦开始就让它完成，避免中断信号留下已创建的库或 Redis 键。
    for (const child of children) if (!cleanupChildren.has(child)) terminate(child);
  });
main().catch((error) => {
  console.error(`真实后台验收失败：${error.message}`);
  process.exitCode = 1;
});
