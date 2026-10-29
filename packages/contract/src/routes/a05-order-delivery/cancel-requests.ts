// 后台：订购、取消、交付与广告任务 · cancel-requests（docs/api/a05-order-delivery.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";
import { adminRoute } from "../builders.js";
import { z } from "../../zod.js";
import { IdSchema, okResponse, errorResponses } from "../../common/index.js";
import { CancelExecuteBodySchema, CancelRequestDetailSchema } from "./cancel.schemas.js";

export const adminCancelRequestList = adminMeta({
  method: "get",
  path: "/admin/cancel-requests",
  operationId: "admin.cancelRequest.list",
  summary:
    "取消申请列表（订购取消、广告取消、资质相关取消）：页签（待审批、待执行、已处理）、单号、商家、类型",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminCancelRequestSummary = adminMeta({
  method: "get",
  path: "/admin/cancel-requests/summary",
  operationId: "admin.cancelRequest.summary",
  summary: "取消申请页签计数与指标：本月退回积分与笔数、审批与执行中、本月驳回",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminCancelRequestGet = adminMeta({
  method: "get",
  path: "/admin/cancel-requests/{cancelRequestId}",
  operationId: "admin.cancelRequest.get",
  summary: "取消申请详情：逐行核算（阶段、已扣、扣除比例、退回）、账本去向、审批与执行结果",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminCancelRequestApprove = adminMeta({
  method: "post",
  path: "/admin/cancel-requests/{cancelRequestId}/approve",
  operationId: "admin.cancelRequest.approve",
  summary: "通过取消申请（订购取消、广告取消、资质相关取消），进入待执行",
  "x-permission": "finance.refund.approve",
  "x-idempotent": "required",
});

export const adminCancelRequestExecute = adminRoute({
  request: {
    params: z.object({ cancelRequestId: IdSchema }),
    body: { required: true, content: { "application/json": { schema: CancelExecuteBodySchema } } },
  },
  responses: {
    ...okResponse(CancelRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  method: "post",
  path: "/admin/cancel-requests/{cancelRequestId}/execute",
  operationId: "admin.cancelRequest.execute",
  summary: "执行退回积分：积分即时退回、订购单变已退回积分、工单终止（执行后不可撤销）",
  "x-permission": "finance.refund.execute",
  "x-idempotent": "required",
});

export const adminCancelRequestReject = adminMeta({
  method: "post",
  path: "/admin/cancel-requests/{cancelRequestId}/reject",
  operationId: "admin.cancelRequest.reject",
  summary: "驳回取消申请（说明必填），关联订购单、广告与工单恢复",
  "x-permission": "finance.refund.approve",
  "x-step-up": "skip",
  "x-idempotent": "required",
});

export const adminCancelRequestVoid = adminMeta({
  method: "post",
  path: "/admin/cancel-requests/{cancelRequestId}/void",
  operationId: "admin.cancelRequest.void",
  summary: "作废已审批未执行的取消申请（说明必填），工单恢复",
  "x-permission": "order.refund.request",
  "x-idempotent": "required",
});

export const adminCancelRequestWithdraw = adminMeta({
  method: "post",
  path: "/admin/cancel-requests/{cancelRequestId}/withdraw",
  operationId: "admin.cancelRequest.withdraw",
  summary: "撤回尚未审批的取消申请（提交人本人；发起人已停用或对象失效时代撤）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});
