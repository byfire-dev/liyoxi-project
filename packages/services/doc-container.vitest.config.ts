import { defineConfig } from "vitest/config";

// 独立本机真实容器验收；普通 services/CI 项目不收集本组。
export default defineConfig({
  test: {
    root: import.meta.dirname,
    name: "services-doc-container",
    include: ["test/doc-container.db.test.ts"],
    globalSetup: ["./src/testing/global-setup.ts"],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
