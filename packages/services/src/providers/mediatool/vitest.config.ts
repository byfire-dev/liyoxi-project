import { defineConfig } from "vitest/config";

// 调用端通过本机 UNIX 套接字与临时文件验证，不需要 services 的数据库模板。
export default defineConfig({
  test: {
    root: import.meta.dirname,
    name: "mediatool",
    include: ["**/*.test.ts"],
  },
});
