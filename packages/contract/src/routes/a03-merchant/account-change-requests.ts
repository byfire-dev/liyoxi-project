// 后台：商家、资质审核与素材复核 · account-change-requests（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminAccountChangeRequestList = adminMeta({
  method: "get",
  path: "/admin/account-change-requests",
  operationId: "admin.accountChangeRequest.list",
  summary: "账号类变更申请（换绑手机号、老板更换、老板复核）列表",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminAccountChangeRequestCreate = adminMeta({
  method: "post",
  path: "/admin/account-change-requests",
  operationId: "admin.accountChangeRequest.create",
  summary: "客服发起换绑手机号、老板更换、老板复核（同事务建审批单）",
  "x-permission": "merchant.account_change.request",
  "x-idempotent": "required",
});

export const adminAccountChangeRequestGet = adminMeta({
  method: "get",
  path: "/admin/account-change-requests/{accountChangeRequestId}",
  operationId: "admin.accountChangeRequest.get",
  summary: "账号类变更申请详情（新手机号脱敏、证明材料、核实记录）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminAccountChangeRequestApprove = adminMeta({
  method: "post",
  path: "/admin/account-change-requests/{accountChangeRequestId}/approve",
  operationId: "admin.accountChangeRequest.approve",
  summary: "通过账号类变更（换绑手机号、老板更换、老板复核），同事务生效",
  "x-permission": "merchant.account_change.approve",
  "x-idempotent": "required",
});

export const adminAccountChangeRequestReject = adminMeta({
  method: "post",
  path: "/admin/account-change-requests/{accountChangeRequestId}/reject",
  operationId: "admin.accountChangeRequest.reject",
  summary: "驳回账号类变更（说明必填）",
  "x-permission": "merchant.account_change.approve",
  "x-step-up": "skip",
  "x-idempotent": "required",
});

export const adminAccountChangeRequestWithdraw = adminMeta({
  method: "post",
  path: "/admin/account-change-requests/{accountChangeRequestId}/withdraw",
  operationId: "admin.accountChangeRequest.withdraw",
  summary: "撤回账号类变更申请（提交人本人；发起人已停用时由决定权限点持有人代撤）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});
