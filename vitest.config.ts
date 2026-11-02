import { defineConfig } from "vitest/config";
import BalancedTestSequencer from "./infra/ci/test-sequencer.js";

export default defineConfig({
  test: {
    // apps/api、apps/worker 写成花括号的匹配式：目录还没建时匹配不到即跳过；
    // 写成字面路径，Vitest 4 会因目录不存在而拒绝启动
    projects: ["packages/*", "apps/{api,worker}", "infra"],
    passWithNoTests: true,
    sequence: { sequencer: BalancedTestSequencer },
  },
});
