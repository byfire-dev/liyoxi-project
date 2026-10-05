// 后台：套餐积分与财务 · subscription-terms（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminSubscriptionTermList = adminMeta({
  method: "get",
  path: "/admin/subscription-terms",
  operationId: "admin.subscriptionTerm.list",
  summary:
    "套餐到期跟进：7 天内到期、已过期未续费（30 天内）、本月已续费；搜索、交付经理、版本筛选",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminSubscriptionTermSummary = adminMeta({
  method: "get",
  path: "/admin/subscription-terms/summary",
  operationId: "admin.subscriptionTerm.summary",
  summary: "套餐到期页 KPI：7 天内到期、已过期未续费、本月续费率",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminSubscriptionTermGet = adminMeta({
  method: "get",
  path: "/admin/subscription-terms/{subscriptionTermId}",
  operationId: "admin.subscriptionTerm.get",
  summary: "到期详情：本期、积分清零与冻结预告、在播短剧、续费信息、提醒时间线、跟进记录",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminSubscriptionTermExtensionQuote = adminMeta({
  method: "post",
  path: "/admin/subscription-terms/{subscriptionTermId}/extension-quote",
  operationId: "admin.subscriptionTerm.extensionQuote",
  summary: "补偿延长影响预览：延长后周期、清零时间顺延、已排队周期后移",
  "x-permission": "billing.extension.request",
  "x-idempotent": "none",
  "x-idempotent-reason": "试算（A20）",
});

export const adminSubscriptionTermRemind = adminMeta({
  method: "post",
  path: "/admin/subscription-terms/{subscriptionTermId}/remind",
  operationId: "admin.subscriptionTerm.remind",
  summary: "补发续费提醒（订阅消息 + 短信；按“主体 + 日期”每天一次）",
  "x-permission": "order.renewal.remind",
  "x-idempotent": "required",
});
