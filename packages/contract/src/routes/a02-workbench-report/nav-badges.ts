// 后台：工作台、报表与导出 · nav-badges（docs/api/a02-workbench-report.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminNavBadgeGet = adminMeta({
  method: "get",
  path: "/admin/nav-badges",
  operationId: "admin.navBadge.get",
  summary: "菜单与二级菜单待办角标（全部后台页面的外壳共用）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
