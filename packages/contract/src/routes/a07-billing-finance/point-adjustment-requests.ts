// 后台：套餐积分与财务 · point-adjustment-requests（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { z } from "../../zod.js";
import { IdSchema, InstantSchema, okResponse, errorResponses } from "../../common/index.js";
import { ApprovalDecisionViewSchema } from "../a01-system/approvals.schemas.js";
import { PaymentOrderAdminDetailSchema } from "./purchase.schemas.js";
import { PointAdjustmentInputSchema } from "./point-accounts.js";

const count = z.int().nonnegative();
export const BillingAdjustmentApprovalSchema = ApprovalDecisionViewSchema.extend({
  requestNo: z.string().nullable(),
  requesterRoleName: z.string().nullable(),
  confirmChecks: z.array(z.string()),
});
export const PointAdjustmentRequestParamsSchema = z.object({ pointAdjustmentRequestId: IdSchema });
export const PointAdjustmentRequestCreateBodySchema = PointAdjustmentInputSchema.safeExtend({
  pointAccountId: IdSchema,
  storeId: IdSchema.optional(),
  note: z.string().trim().min(5).max(200),
  termExtensionRequestId: IdSchema.optional(),
  serviceTicketId: IdSchema.optional(),
  confirm: z.strictObject({ spendableBeforePoints: count }),
}).refine((x) => !x.termExtensionRequestId || x.direction === "increase", {
  message: "延长关联调整只能增加",
  path: ["direction"],
});
export const PointAdjustmentApproveBodySchema = z.strictObject({
  lockVersion: count,
  confirm: z.strictObject({
    requestNo: z.string().min(1),
    direction: z.enum(["increase", "decrease"]),
    adjustPoints: z.int().positive(),
  }),
  confirmChecks: z.array(z.literal("basis_checked")).length(1),
});
export const BillingAdjustmentRejectBodySchema = z.strictObject({
  reasonCodes: z.array(z.string().min(1).max(64)).max(1).optional(),
  note: z.string().trim().min(1).max(200),
});
export const BillingAdjustmentWithdrawBodySchema = z.strictObject({
  note: z.string().trim().max(200).optional(),
});
export const PointAdjustmentRequestDetailSchema = z.object({
  pointAdjustmentRequestId: IdSchema,
  requestNo: z.string().nullable(),
  entity: PaymentOrderAdminDetailSchema.shape.entity,
  direction: z.enum(["increase", "decrease"]),
  lotKind: z.enum(["plan", "addon"]),
  adjustPoints: z.int().positive(),
  signedPoints: z.int(),
  reasonCode: PointAdjustmentInputSchema.shape.reasonCode,
  note: z.string(),
  pointHold: z
    .object({
      pointHoldId: IdSchema,
      purpose: z.string(),
      groupRef: z.string().nullable(),
      qty: count,
      status: z.string(),
    })
    .nullable(),
  termExtensionRequest: z
    .object({ termExtensionRequestId: IdSchema, requestNo: z.string().nullable() })
    .nullable(),
  spendableBeforePoints: count,
  spendableAfterPreviewPoints: z.int(),
  currentSpendablePoints: count,
  applied: z
    .object({ ledgerOperationId: IdSchema, appliedAt: InstantSchema, spendableAfterPoints: count })
    .nullable(),
  relatedServiceTickets: z.array(z.object({ serviceTicketId: IdSchema, ticketNo: z.string() })),
  approval: BillingAdjustmentApprovalSchema,
  actions: z.array(z.enum(["approve", "reject", "withdraw"])),
});
export type PointAdjustmentRequestCreateBody = z.infer<
  typeof PointAdjustmentRequestCreateBodySchema
>;
export type PointAdjustmentApproveBody = z.infer<typeof PointAdjustmentApproveBodySchema>;
export type BillingAdjustmentRejectBody = z.infer<typeof BillingAdjustmentRejectBodySchema>;
export type BillingAdjustmentWithdrawBody = z.infer<typeof BillingAdjustmentWithdrawBodySchema>;

export const adminPointAdjustmentRequestCreate = adminRoute({
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: PointAdjustmentRequestCreateBodySchema } },
    },
  },
  responses: {
    ...okResponse(PointAdjustmentRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  method: "post",
  path: "/admin/point-adjustment-requests",
  operationId: "admin.pointAdjustmentRequest.create",
  summary:
    "发起积分调整（方向、积分类型、数量、原因、说明 5–200 字；可关联订购、广告）：同事务建审批单，提交不动账",
  "x-permission": "billing.adjust.request",
  "x-idempotent": "required",
});

export const adminPointAdjustmentRequestGet = adminRoute({
  request: { params: PointAdjustmentRequestParamsSchema },
  responses: {
    ...okResponse(PointAdjustmentRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404),
  },
  method: "get",
  path: "/admin/point-adjustment-requests/{pointAdjustmentRequestId}",
  operationId: "admin.pointAdjustmentRequest.get",
  summary:
    "积分调整单详情：方向、积分类型、数量、原因与说明、关联订购或广告、调整前后可用积分、入账结果与审批记录",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPointAdjustmentRequestApprove = adminRoute({
  request: {
    params: PointAdjustmentRequestParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: PointAdjustmentApproveBodySchema } },
    },
  },
  responses: {
    ...okResponse(PointAdjustmentRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
  method: "post",
  path: "/admin/point-adjustment-requests/{pointAdjustmentRequestId}/approve",
  operationId: "admin.pointAdjustmentRequest.approve",
  summary: "通过积分调整（同一事务入账）",
  "x-permission": "billing.adjust.approve",
  "x-idempotent": "required",
});

export const adminPointAdjustmentRequestReject = adminRoute({
  request: {
    params: PointAdjustmentRequestParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: BillingAdjustmentRejectBodySchema } },
    },
  },
  responses: {
    ...okResponse(PointAdjustmentRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409),
  },
  method: "post",
  path: "/admin/point-adjustment-requests/{pointAdjustmentRequestId}/reject",
  operationId: "admin.pointAdjustmentRequest.reject",
  summary: "驳回积分调整（原因可选，说明必填）",
  "x-permission": "billing.adjust.approve",
  "x-step-up": "skip",
  "x-idempotent": "required",
});

export const adminPointAdjustmentRequestWithdraw = adminRoute({
  request: {
    params: PointAdjustmentRequestParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: BillingAdjustmentWithdrawBodySchema } },
    },
  },
  responses: {
    ...okResponse(PointAdjustmentRequestDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409),
  },
  method: "post",
  path: "/admin/point-adjustment-requests/{pointAdjustmentRequestId}/withdraw",
  operationId: "admin.pointAdjustmentRequest.withdraw",
  summary: "撤回待审的积分调整（提交人本人；发起人已停用时代撤）",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});
