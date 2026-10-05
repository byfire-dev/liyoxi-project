// 后台：发布与巡检 · takedown-tasks（docs/api/a06-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminTakedownTaskList = adminMeta({
  method: "get",
  path: "/admin/takedown-tasks",
  operationId: "admin.takedownTask.list",
  summary: "下架核查队列：待核查、已核查（逾期、今日截止标记）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminTakedownTaskBatchCheck = adminMeta({
  method: "post",
  path: "/admin/takedown-tasks/check",
  operationId: "admin.takedownTask.batchCheck",
  summary: "批量核查下架（每个任务各带证据截图）",
  "x-permission": "publish.takedown.check",
  "x-idempotent": "required",
});

export const adminTakedownTaskSummary = adminMeta({
  method: "get",
  path: "/admin/takedown-tasks/summary",
  operationId: "admin.takedownTask.summary",
  summary: "下架核查页签计数：待核查、已核查（含逾期、今日截止）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminTakedownTaskGet = adminMeta({
  method: "get",
  path: "/admin/takedown-tasks/{takedownTaskId}",
  operationId: "admin.takedownTask.get",
  summary: "下架任务详情：使用期、结束依据、下架方式与商家确认、处理记录、证据截图",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminTakedownTaskCheck = adminMeta({
  method: "post",
  path: "/admin/takedown-tasks/{takedownTaskId}/check",
  operationId: "admin.takedownTask.check",
  summary: "核查通过（清单全过，证据截图 ≥2 张，长期留存）；全部账号核查后工单归档",
  "x-permission": "publish.takedown.check",
  "x-idempotent": "required",
});

export const adminTakedownTaskEscalate = adminMeta({
  method: "post",
  path: "/admin/takedown-tasks/{takedownTaskId}/escalate",
  operationId: "admin.takedownTask.escalate",
  summary: "逾期未下架手动升级（通知交付主管与交付经理）",
  "x-permission": "publish.takedown.check",
  "x-idempotent": "required",
});

export const adminTakedownTaskMarkOnline = adminMeta({
  method: "post",
  path: "/admin/takedown-tasks/{takedownTaskId}/mark-online",
  operationId: "admin.takedownTask.markOnline",
  summary: "抽查仍在线：记录结果、通知商家、升级交付主管",
  "x-permission": "publish.takedown.check",
  "x-idempotent": "required",
});

export const adminTakedownTaskSendBreachNotice = adminMeta({
  method: "post",
  path: "/admin/takedown-tasks/{takedownTaskId}/send-breach-notice",
  operationId: "admin.takedownTask.sendBreachNotice",
  summary: "发送违约提醒：要求 24 小时内删除作品或设为仅自己可见（限频）",
  "x-permission": "publish.takedown.breach_notice",
  "x-idempotent": "required",
});
