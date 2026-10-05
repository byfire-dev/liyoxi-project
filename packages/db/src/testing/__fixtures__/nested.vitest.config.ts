import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// 嵌套跑的一轮：worker.test.ts、parallel.test.ts 起子进程跑本目录下的 *.fixture.ts，
// 用来在真的 Vitest 里验证“按 worker 建库”与收尾的钩子。平时的 pnpm test 不会直接收进这些文件。
// 不挂 globalSetup：模板库用外层那一轮建好的，会话标识经环境变量 LYX_TEST_SESSION 传进来。
export default defineConfig({
  test: {
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    include: ["src/testing/__fixtures__/*.fixture.ts"],
  },
});
