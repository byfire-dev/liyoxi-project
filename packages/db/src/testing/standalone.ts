// @liyoxi/db/testing/standalone：测试支架里不带 Vitest 的那一半（W0-25）。
// 库名与守卫、建库删库、派生模板库、不靠模板的迁移库。命令行脚本（如 pnpm test:db:seeded）从这里引：
// ./index.ts 还带着 worker.ts，它一加载就引 Vitest，不在一轮测试里的进程用不着。

export * from "./database.js";
export * from "./derived.js";
