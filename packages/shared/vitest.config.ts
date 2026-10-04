import { defineProject } from "vitest/config";

// 性质测试（fast-check）的种子与轮次：PR 上用固定种子、每个性质 200 轮（D7 第 10.2 节）。
// 要跑大轮次或复现某个种子时用环境变量改，例：
//   LYX_FC_RUNS=5000 LYX_FC_SEED=42 pnpm --filter @liyoxi/shared test
// 用例里用 inject("fcRuns")、inject("fcSeed") 取。
const fcRuns = Number(process.env.LYX_FC_RUNS ?? 200);
const fcSeed = Number(process.env.LYX_FC_SEED ?? 20261004);

export default defineProject({
  test: {
    name: "shared",
    include: ["src/**/*.test.ts"],
    provide: { fcRuns, fcSeed },
  },
});

declare module "vitest" {
  export interface ProvidedContext {
    fcRuns: number;
    fcSeed: number;
  }
}
