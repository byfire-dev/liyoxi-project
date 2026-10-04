// 数据访问规则片段（D7 第 2.2 节 D3）：api、worker 与三个前端的源码不得引数据包与数据库驱动。
// 门禁是 dependency-cruiser 的 db-only-from-services；这里只为在编辑器里即时提示。
// 装配文件要引客户端工厂时，两处一起放开，走单独的 gate-change PR（W0-02 任务书 第 11 节第 5 项）。
import { repoRestrictedImports } from "./repo.js";

/** 应用层源码所在的路径 */
export const dataAccessFiles = ["apps/{api,worker,weapp,admin,portal}/src/**/*.{ts,tsx,js,jsx}"];

const message = "应用层不直接查库：业务能力经 @liyoxi/services 的公开入口取（D7 第 2.2 节 D3）。";

/** 同一条规则后写的配置会整条盖掉前面的，所以这里把全仓的条目一并带上 */
export const dataAccessRestrictedImports = {
  paths: [
    ...repoRestrictedImports.paths,
    { name: "@liyoxi/db", message },
    { name: "@prisma/client", message },
    { name: "pg", message },
  ],
  patterns: [
    ...repoRestrictedImports.patterns,
    { group: ["@liyoxi/db/*", "@prisma/client/*", "pg/*"], message },
  ],
};

export const dataAccessRules = {
  "no-restricted-imports": ["error", dataAccessRestrictedImports],
};
