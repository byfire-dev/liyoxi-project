// 后台：工作台、报表与导出 · search（docs/api/a02-workbench-report.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminSearchGet = adminMeta({
  method: "get",
  path: "/admin/search",
  operationId: "admin.search.get",
  summary: "全局搜索：单号前缀匹配、门店名与主体名包含匹配（按类型分组，每组至多 5 条）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
