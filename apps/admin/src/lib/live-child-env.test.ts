import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
