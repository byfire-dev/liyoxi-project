import { defineProject } from "vitest/config";

// 性质测试（fast-check）的种子与轮次：PR 上用固定种子、每个性质 200 轮（D7 第 10.2 节）。
// 要跑大轮次或复现某个种子时用环境变量改，例：
//   LYX_FC_RUNS=5000 LYX_FC_SEED=42 pnpm --filter @liyoxi/shared test
// 用例里用 inject("fcRuns")、inject("fcSeed") 取。
// 性质用例失败时 fast-check 会打印种子与最小化后的反例：把反例固化成固定用例再修。
function envInteger(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} 必须是不小于 ${min} 的整数，收到 ${raw}`);
  }
  return value;
}

const fcRuns = envInteger("LYX_FC_RUNS", 200, 1);
const fcSeed = envInteger("LYX_FC_SEED", 20261004, Number.MIN_SAFE_INTEGER);

export default defineProject({
  test: {
    name: "shared",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    provide: { fcRuns, fcSeed },
  },
});

declare module "vitest" {
  export interface ProvidedContext {
    fcRuns: number;
    fcSeed: number;
  }
}
