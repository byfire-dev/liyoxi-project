// 后台：套餐积分与财务 · billing-params（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminBillingParamList = adminMeta({
  method: "get",
  path: "/admin/billing-params",
  operationId: "admin.billingParam.list",
  summary:
    "积分规则参数：取消扣除比例三档、广告每条积分、免费修改次数、顶级模型加扣、最短可订授权期、可选购买周期、提醒节点；当前值、待生效值与默认值",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminBillingParamWithdraw = adminMeta({
  method: "post",
  path: "/admin/billing-params/{billingParamId}/withdraw",
  operationId: "admin.billingParam.withdraw",
  summary: "撤销一条待生效参数（整组撤销时撤回公告）",
  "x-permission": "billing.param.edit",
  "x-idempotent": "required",
});
