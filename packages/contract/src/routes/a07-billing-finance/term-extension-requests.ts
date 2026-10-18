// 后台：套餐积分与财务 · term-extension-requests（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { z } from "../../zod.js";
import {
  IdSchema,
  DateSchema,
  InstantSchema,
  okResponse,
  errorResponses,
} from "../../common/index.js";
import { PaymentOrderAdminDetailSchema } from "./purchase.schemas.js";
import { ExtensionQuoteSchema } from "./subscription-terms.js";
import {
  BillingAdjustmentApprovalSchema,
  BillingAdjustmentRejectBodySchema,
  BillingAdjustmentWithdrawBodySchema,
} from "./point-adjustment-requests.js";
export const TermExtensionRequestParamsSchema = z.object({ termExtensionRequestId: IdSchema });
export const TermExtensionRequestCreateBodySchema = z.strictObject({
  subscriptionTermId: IdSchema,
  days: z.int().min(1).max(90),
  reasonCode: z.string().min(1).max(64),
  note: z.string().trim().min(1).max(200),
  confirm: z.strictObject({ subscriptionTermId: IdSchema, endDate: DateSchema }),
});
export const TermExtensionApproveBodySchema = z.strictObject({
  lockVersion: z.int().nonnegative(),
  confirm: z.strictObject({ requestNo: z.string().min(1), days: z.int().min(1).max(90) }),
  confirmChecks: z.array(z.literal("effect_preview_checked")).length(1),
});
export const TermExtensionRequestDetailSchema = z.object({
  termExtensionRequestId: IdSchema,
  requestNo: z.string().nullable(),
  entity: PaymentOrderAdminDetailSchema.shape.entity,
  subscriptionTerm: z.object({
    subscriptionTermId: IdSchema,
    planName: z.string(),
    startDate: DateSchema,
    endDate: DateSchema,
  }),
  days: z.int().min(1).max(90),
  reason: z.object({ code: z.string(), name: z.string() }),
  note: z.string(),
  preview: ExtensionQuoteSchema.nullable(),
  applied: z
    .object({
      appliedSubscriptionTermId: IdSchema,
      appliedMode: z.enum(["extend", "revive"]),
      prevEndDate: DateSchema,
      newEndDate: DateSchema,
      appliedAt: InstantSchema,
      ledgerOperationId: IdSchema,
    })
    .nullable(),
  relatedAdjustments: z.array(
    z.object({
      pointAdjustmentRequestId: IdSchema,
      requestNo: z.string().nullable(),
      status: z.string(),
    }),
  ),
  approval: BillingAdjustmentApprovalSchema,
  actions: z.array(z.enum(["approve", "reject", "withdraw"])),
});
export type TermExtensionRequestCreateBody = z.infer<typeof TermExtensionRequestCreateBodySchema>;
export type TermExtensionApproveBody = z.infer<typeof TermExtensionApproveBodySchema>;

export const adminTermExtensionRequestCreate = adminRoute({
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: TermExtensionRequestCreateBodySchema } },
    },
  },
  responses: {
    ...okResponse(TermExtensionRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  method: "post",
  path: "/admin/term-extension-requests",
  operationId: "admin.termExtensionRequest.create",
  summary: "发起补偿延长（3 / 7 / 15 / 30 天、原因、说明）：同事务建审批单，主管审批通过即顺延",
  "x-permission": "billing.extension.request",
  "x-idempotent": "required",
});

export const adminTermExtensionRequestGet = adminRoute({
  request: { params: TermExtensionRequestParamsSchema },
  responses: {
    ...okResponse(TermExtensionRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404),
  },
  method: "get",
  path: "/admin/term-extension-requests/{termExtensionRequestId}",
  operationId: "admin.termExtensionRequest.get",
  summary:
    "补偿延长单详情：延长天数、原因与说明、延长前后的周期、清零时间的顺延、执行结果与审批记录",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminTermExtensionRequestApprove = adminRoute({
  request: {
    params: TermExtensionRequestParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: TermExtensionApproveBodySchema } },
    },
  },
  responses: {
    ...okResponse(TermExtensionRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  method: "post",
  path: "/admin/term-extension-requests/{termExtensionRequestId}/approve",
  operationId: "admin.termExtensionRequest.approve",
  summary: "通过补偿延长（同一事务顺延有效期；已到期未续费则复活周期）",
  "x-permission": "billing.extension.approve",
  "x-idempotent": "required",
});

export const adminTermExtensionRequestReject = adminRoute({
  request: {
    params: TermExtensionRequestParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: BillingAdjustmentRejectBodySchema } },
    },
  },
  responses: {
    ...okResponse(TermExtensionRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409),
  },
  method: "post",
  path: "/admin/term-extension-requests/{termExtensionRequestId}/reject",
  operationId: "admin.termExtensionRequest.reject",
  summary: "驳回补偿延长（说明必填）",
  "x-permission": "billing.extension.approve",
  "x-step-up": "skip",
  "x-idempotent": "required",
});

export const adminTermExtensionRequestWithdraw = adminRoute({
  request: {
    params: TermExtensionRequestParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: BillingAdjustmentWithdrawBodySchema } },
    },
  },
  responses: {
    ...okResponse(TermExtensionRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409),
  },
  method: "post",
  path: "/admin/term-extension-requests/{termExtensionRequestId}/withdraw",
  operationId: "admin.termExtensionRequest.withdraw",
  summary: "撤回待审的补偿延长（提交人本人；发起人已停用时代撤）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});
