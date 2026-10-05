// 商家端：交付与发布 · takedown-tasks（docs/api/m05-delivery-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mTakedownTaskList = merchantMeta({
  method: "get",
  path: "/m/takedown-tasks",
  operationId: "m.takedownTask.list",
  summary:
    "下架任务（?tab=pending|done）：剧目、账号、使用期止日、应完成日；无任务时给出最早结束剧目与下架任务生成日",
  "x-capability": "publish.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mTakedownTaskSummary = merchantMeta({
  method: "get",
  path: "/m/takedown-tasks/summary",
  operationId: "m.takedownTask.summary",
  summary: "发布任务页“待下架 N / 已完成 N”中下架任务一侧的计数，键与列表 tab 取值一致",
  "x-capability": "publish.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mTakedownTaskConfirm = merchantMeta({
  method: "post",
  path: "/m/takedown-tasks/{takedownTaskId}/confirm",
  operationId: "m.takedownTask.confirm",
  summary: "确认已下架 {method: delete | private | not_published}",
  "x-capability": "publish.takedown_confirm",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});
