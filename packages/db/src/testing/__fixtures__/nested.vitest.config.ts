import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// 嵌套跑的一轮：worker.test.ts、parallel.test.ts 起子进程跑本目录下的 *.fixture.ts，
// 用来在真的 Vitest 里验证“按 worker 建库”与收尾的钩子。平时的 pnpm test 不会直接收进这些文件。
// 不挂 globalSetup：模板库用外层那一轮建好的，会话标识经环境变量 LYX_TEST_SESSION 传进来。
// globalSetup 平时给出的并行数（useTestDatabase 靠它确认支架挂上了）在这里由 nested.ts 经环境变量给：
// 没给就不提供，夹具里的 useTestDatabase 会报“没有挂 globalSetup”（worker.test.ts 有一条专门验这个）。
const workers = Number(process.env.LYX_TEST_NESTED_WORKERS ?? "");

export default defineConfig({
  test: {
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    include: ["src/testing/__fixtures__/*.fixture.ts"],
    provide: workers > 0 ? { lyxTestMaxWorkers: workers } : {},
  },
});
