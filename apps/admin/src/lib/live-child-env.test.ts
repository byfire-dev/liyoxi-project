import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { liveChildEnv, liveChildFailure } from "../../test/e2e/live-child-env";

it("真实 pnpm 子进程保留兼容 job 的显式引擎设置，未设置仍严格拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "lyx-live-engine-"));
  try {
    // 当前 Node24 对 <24 不兼容，等价于 nightly Node26 对根 <25 的不兼容；不下载 runtime。
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "lyx-engine-probe", engines: { node: "<24" } }),
    );
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app/package.json"), JSON.stringify({ name: "lyx-engine-marker" }));
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - app\n");
    writeFileSync(join(dir, ".npmrc"), "engine-strict=true\n");
    const run = (source: NodeJS.ProcessEnv) =>
      spawnSync(
        "pnpm",
        [
          "--filter",
          "lyx-engine-marker",
          "exec",
          "node",
          "-e",
          "process.stdout.write('engine-marker')",
        ],
        {
          cwd: dir,
          env: liveChildEnv(["PATH", "HOME", "USER", "TMPDIR"], source),
          encoding: "utf8",
          timeout: 10_000,
        },
      );
    const source = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NPM_CONFIG_ENGINE_STRICT: "false",
      DATA_KEYS_FILE: "must-not-pass",
    };
    const compatible = run(source);
    expect(compatible.status, "显式兼容 parent 设置必须抵达真正子 pnpm").toBe(0);
    expect(compatible.stdout).toContain("engine-marker");
    expect(liveChildEnv(["PATH"], source)).not.toHaveProperty("DATA_KEYS_FILE");
    const strict = run({ PATH: process.env.PATH, HOME: process.env.HOME });
    expect(strict.status).not.toBe(0);
    expect(`${strict.stdout}${strict.stderr}`).toContain("ERR_PNPM_UNSUPPORTED_ENGINE");
    expect(strict.stdout).not.toContain("engine-marker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

it("诊断只保留明确非秘密符号，不泄露任意 stderr", () => {
  expect(liveChildFailure("失败", "ERR_PNPM_UNSUPPORTED_ENGINE password=secret").message).toBe(
    "失败：ERR_PNPM_UNSUPPORTED_ENGINE",
  );
  expect(liveChildFailure("失败", Buffer.from("DATABASE_URL=secret")).message).toBe(
    "失败：子进程未正常完成",
  );
  expect(liveChildEnv(["PATH"], { PATH: "p", NPM_CONFIG_ENGINE_STRICT: "true" })).toEqual({
    PATH: "p",
    NPM_CONFIG_ENGINE_STRICT: "true",
  });
  expect(liveChildEnv(["PATH"], { PATH: "p" })).toEqual({ PATH: "p" });
});

function ownedCache() {
  const directory = fileURLToPath(
    new URL(`../../dist/tmp/admin-live-${randomBytes(8).toString("hex")}/`, import.meta.url),
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const context = join(directory, "context.json");
  const cache = join(directory, "node-compile-cache");
  writeFileSync(context, "{}", { mode: 0o600 });
  mkdirSync(cache, { mode: 0o700 });
  return {
    directory,
    context,
    cache,
    source: { LYX_ADMIN_LIVE_CONTEXT: context, NODE_COMPILE_CACHE: cache },
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

it("只传递本轮私有缓存，外部路径、符号链接、宽权限及覆盖采集均不启用", () => {
  const own = ownedCache();
  try {
    const source = { ...own.source, PATH: "p", DATA_KEYS_FILE: "must-not-pass" };
    expect(liveChildEnv(["PATH"], source)).toEqual({ PATH: "p", NODE_COMPILE_CACHE: own.cache });
    for (const invalid of [
      { ...source, NODE_COMPILE_CACHE: "/tmp/arbitrary-cache" },
      { ...source, NODE_COMPILE_CACHE: "node-compile-cache" },
      { ...source, NODE_COMPILE_CACHE: `${own.cache}/../node-compile-cache` },
      { ...source, LYX_ADMIN_LIVE_CONTEXT: "/tmp/context.json" },
      { ...source, LYX_ADMIN_LIVE_CONTEXT: undefined },
      { ...source, NODE_V8_COVERAGE: "/tmp/coverage" },
    ])
      expect(liveChildEnv(["PATH", "NODE_COMPILE_CACHE"], invalid)).toEqual({ PATH: "p" });
    chmodSync(own.cache, 0o755);
    expect(liveChildEnv([], source)).toEqual({});
    chmodSync(own.cache, 0o700);
    chmodSync(own.context, 0o644);
    expect(liveChildEnv([], source)).toEqual({});
    chmodSync(own.context, 0o600);
    const target = join(own.directory, "other-cache");
    mkdirSync(target, { mode: 0o700 });
    rmSync(own.cache, { recursive: true });
    symlinkSync(target, own.cache, "dir");
    expect(liveChildEnv([], source)).toEqual({});
  } finally {
    own.close();
  }
  expect(liveChildEnv([], own.source)).toEqual({});
});

it("两个独立 Node 子进程生成并复用本轮缓存，模块仍逐次执行", () => {
  const own = ownedCache();
  try {
    const module = join(own.directory, "cache-probe.mjs");
    writeFileSync(module, "process.stdout.write('module-executed\\n'); export const value = 42;\n");
    const run = () => {
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          "import { getCompileCacheDir } from 'node:module'; const {value}=await import(process.argv[1]); console.log(JSON.stringify({value,cache:getCompileCacheDir()}));",
          pathToFileURL(module).href,
        ],
        {
          env: liveChildEnv(["PATH", "HOME", "TMPDIR"], {
            ...process.env,
            ...own.source,
            NODE_V8_COVERAGE: undefined,
          }),
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(child.status, child.stderr).toBe(0);
      const [executed, result] = child.stdout.trim().split("\n");
      expect(executed).toBe("module-executed");
      const parsed = JSON.parse(result!);
      expect(parsed.value).toBe(42);
      expect(parsed.cache.startsWith(`${own.cache}${sep}`)).toBe(true);
    };
    const cacheFiles = () =>
      readdirSync(own.cache, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const path = join(entry.parentPath, entry.name);
          return {
            path,
            mtime: statSync(path).mtimeMs,
            sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
          };
        })
        .sort((a, b) => a.path.localeCompare(b.path));
    run(); // Normal child exit flushes its compiled module to disk.
    const first = cacheFiles();
    expect(first.length).toBeGreaterThan(0);
    run();
    expect(cacheFiles()).toEqual(first);
  } finally {
    own.close();
  }
}, 30_000);
