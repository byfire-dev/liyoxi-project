// 后台：套餐积分与财务 · point-adjustment-requests（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminPointAdjustmentRequestCreate = adminMeta({
  method: "post",
  path: "/admin/point-adjustment-requests",
  operationId: "admin.pointAdjustmentRequest.create",
  summary:
    "发起积分调整（方向、积分类型、数量、原因、说明 5–200 字；可关联订购、广告）：同事务建审批单，提交不动账",
  "x-permission": "billing.adjust.request",
  "x-idempotent": "required",
});

export const adminPointAdjustmentRequestGet = adminMeta({
  method: "get",
  path: "/admin/point-adjustment-requests/{pointAdjustmentRequestId}",
  operationId: "admin.pointAdjustmentRequest.get",
  summary:
    "积分调整单详情：方向、积分类型、数量、原因与说明、关联订购或广告、调整前后可用积分、入账结果与审批记录",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPointAdjustmentRequestApprove = adminMeta({
  method: "post",
  path: "/admin/point-adjustment-requests/{pointAdjustmentRequestId}/approve",
  operationId: "admin.pointAdjustmentRequest.approve",
  summary: "通过积分调整（同一事务入账）",
  "x-permission": "billing.adjust.approve",
  "x-idempotent": "required",
});

export const adminPointAdjustmentRequestReject = adminMeta({
  method: "post",
  path: "/admin/point-adjustment-requests/{pointAdjustmentRequestId}/reject",
  operationId: "admin.pointAdjustmentRequest.reject",
  summary: "驳回积分调整（原因可选，说明必填）",
  "x-permission": "billing.adjust.approve",
  "x-step-up": "skip",
  "x-idempotent": "required",
});

export const adminPointAdjustmentRequestWithdraw = adminMeta({
  method: "post",
  path: "/admin/point-adjustment-requests/{pointAdjustmentRequestId}/withdraw",
  operationId: "admin.pointAdjustmentRequest.withdraw",
  summary: "撤回待审的积分调整（提交人本人；发起人已停用时代撤）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});
