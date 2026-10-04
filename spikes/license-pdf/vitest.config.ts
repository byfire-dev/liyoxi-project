import { defineConfig } from "vitest/config";

// 独立工程自己的用例。渲染要读三个十几兆的字体，超时放宽
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
