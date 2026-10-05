// 后台：发布与巡检 · launch-calendar（docs/api/a06-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminLaunchCalendarGet = adminMeta({
  method: "get",
  path: "/admin/launch-calendar",
  operationId: "admin.launchCalendar.get",
  summary:
    "上线日历：按约定上线日聚合交付中的工单（制作中、待上线、上线核验、已逾期），可按交付经理筛选；当日与逾期面板",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
