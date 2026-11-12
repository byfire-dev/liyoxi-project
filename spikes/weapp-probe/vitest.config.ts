import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["server/test/**/*.test.ts", "app/test/**/*.test.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 10000,
  },
});
