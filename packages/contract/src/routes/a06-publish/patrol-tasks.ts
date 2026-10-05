// 后台：发布与巡检 · patrol-tasks（docs/api/a06-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminPatrolTaskList = adminMeta({
  method: "get",
  path: "/admin/patrol-tasks",
  operationId: "admin.patrolTask.list",
  summary: "作品巡检列表：本周批次、页签（全部、待巡检、异常、正常），异常排前",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPatrolTaskCreate = adminMeta({
  method: "post",
  path: "/admin/patrol-tasks",
  operationId: "admin.patrolTask.create",
  summary: "手动发起巡检（同一上线任务已有在办巡检时返回那一条）",
  "x-permission": "publish.patrol.do",
  "x-idempotent": "required",
});

export const adminPatrolTaskSummary = adminMeta({
  method: "get",
  path: "/admin/patrol-tasks/summary",
  operationId: "admin.patrolTask.summary",
  summary: "本周巡检页头：上线中部数、抽查数、已巡检、异常",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPatrolTaskGet = adminMeta({
  method: "get",
  path: "/admin/patrol-tasks/{patrolTaskId}",
  operationId: "admin.patrolTask.get",
  summary: "巡检任务详情：账号、使用期、异常信息、巡检项",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPatrolTaskMarkAbnormal = adminMeta({
  method: "post",
  path: "/admin/patrol-tasks/{patrolTaskId}/mark-abnormal",
  operationId: "admin.patrolTask.markAbnormal",
  summary: "发现异常：异常类型与说明、截图；通知商家，3 天后仍异常转交付经理待办",
  "x-permission": "publish.patrol.do",
  "x-idempotent": "required",
});

export const adminPatrolTaskMarkNormal = adminMeta({
  method: "post",
  path: "/admin/patrol-tasks/{patrolTaskId}/mark-normal",
  operationId: "admin.patrolTask.markNormal",
  summary: "巡检正常（清单全过，截图至少 1 张）",
  "x-permission": "publish.patrol.do",
  "x-idempotent": "required",
});

export const adminPatrolTaskRecover = adminMeta({
  method: "post",
  path: "/admin/patrol-tasks/{patrolTaskId}/recover",
  operationId: "admin.patrolTask.recover",
  summary: "复查已恢复（清单全过，追加复查截图）",
  "x-permission": "publish.patrol.do",
  "x-idempotent": "required",
});

export const adminPatrolTaskRemind = adminMeta({
  method: "post",
  path: "/admin/patrol-tasks/{patrolTaskId}/remind",
  operationId: "admin.patrolTask.remind",
  summary: "再次提醒商家处理异常（限频）",
  "x-permission": "publish.patrol.do",
  "x-idempotent": "required",
});
