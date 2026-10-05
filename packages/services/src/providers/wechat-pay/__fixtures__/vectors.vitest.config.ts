import { defineConfig } from "vitest/config";

// pnpm wxpay:vectors 专用：只跑 cross-check.generate.ts。它要 Docker 与外网，不在日常的 pnpm test 里
// （日常的用例只认 *.test.ts）。容器第一次跑要下载 SDK 并编译，超时放宽到 10 分钟。
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["cross-check.generate.ts"],
    testTimeout: 600_000,
  },
});
