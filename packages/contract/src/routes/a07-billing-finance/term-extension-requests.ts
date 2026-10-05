// 后台：套餐积分与财务 · term-extension-requests（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminTermExtensionRequestCreate = adminMeta({
  method: "post",
  path: "/admin/term-extension-requests",
  operationId: "admin.termExtensionRequest.create",
  summary: "发起补偿延长（3 / 7 / 15 / 30 天、原因、说明）：同事务建审批单，主管审批通过即顺延",
  "x-permission": "billing.extension.request",
  "x-idempotent": "required",
});

export const adminTermExtensionRequestGet = adminMeta({
  method: "get",
  path: "/admin/term-extension-requests/{termExtensionRequestId}",
  operationId: "admin.termExtensionRequest.get",
  summary:
    "补偿延长单详情：延长天数、原因与说明、延长前后的周期、清零时间的顺延、执行结果与审批记录",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminTermExtensionRequestApprove = adminMeta({
  method: "post",
  path: "/admin/term-extension-requests/{termExtensionRequestId}/approve",
  operationId: "admin.termExtensionRequest.approve",
  summary: "通过补偿延长（同一事务顺延有效期；已到期未续费则复活周期）",
  "x-permission": "billing.extension.approve",
  "x-idempotent": "required",
});

export const adminTermExtensionRequestReject = adminMeta({
  method: "post",
  path: "/admin/term-extension-requests/{termExtensionRequestId}/reject",
  operationId: "admin.termExtensionRequest.reject",
  summary: "驳回补偿延长（说明必填）",
  "x-permission": "billing.extension.approve",
  "x-step-up": "skip",
  "x-idempotent": "required",
});

export const adminTermExtensionRequestWithdraw = adminMeta({
  method: "post",
  path: "/admin/term-extension-requests/{termExtensionRequestId}/withdraw",
  operationId: "admin.termExtensionRequest.withdraw",
  summary: "撤回待审的补偿延长（提交人本人；发起人已停用时代撤）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});
