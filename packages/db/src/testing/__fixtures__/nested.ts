import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 起一个子进程跑嵌套的一轮 Vitest（配置见 nested.vitest.config.ts）。

const CONFIG = fileURLToPath(new URL("./nested.vitest.config.ts", import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL("../../../", import.meta.url));
const VITEST = join(
  dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
  "vitest.mjs",
);

export interface NestedRun {
  status: number | null;
  output: string;
}

/** @param filter 文件名里的一段，只跑对得上的夹具 */
export function runNestedVitest(
  filter: string,
  options: { maxWorkers: number; env?: Record<string, string> },
): NestedRun {
  const result = spawnSync(
    process.execPath,
    [VITEST, "run", "--config", CONFIG, `--maxWorkers=${options.maxWorkers}`, filter],
    {
      cwd: PACKAGE_DIR,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: undefined, ...options.env },
      timeout: 150_000,
    },
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}
