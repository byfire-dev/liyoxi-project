// @liyoxi/db/testing：测试库支架的出口（W0-05b）。只给测试用，不进生产装配。
// 其余的包经 @liyoxi/services/testing 拿到这里的全部导出；globalSetup 另走 ./global-setup 子路径。

export * from "./database.js";
export * from "./worker.js";
// W0-25：派生模板库（带种子的库靠它）、不靠模板的迁移库
export * from "./derived.js";
