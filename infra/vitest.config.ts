import { defineProject } from "vitest/config";

// infra/ci 的检查脚本用例：真 git、真子进程，仓库外的临时目录里造反例
export default defineProject({
  test: {
    name: "infra",
    include: ["ci/test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
