// a05 §2.2/3.6/3.61：只读核算 DTO；此处不接管任何 HTTP 路由。
import { z } from "../../zod.js";
import { IdSchema, DateSchema, InstantSchema } from "../../common/index.js";
import { CANCEL_REQUEST_LINE_STAGE, PRODUCTION_MODEL } from "../../enums/index.js";
import { zodEnum } from "../../enums/zod.js";
const points = z.int().nonnegative();
const inputId = IdSchema.transform((v) => v.toLowerCase());
export const CancelReasonSchema = z.enum([
  "merchant_request",
  "store_closed",
  "platform_fault",
  "qualification_final",
]);
const manual = z.strictObject({
  orderItemId: inputId,
  deductPoints: points,
  deductNote: z.string().trim().min(1).max(200),
});
export const OrderCancelQuoteBodySchema = z.strictObject({
  reasonCode: CancelReasonSchema.exclude(["qualification_final"]),
  orderItemIds: z
    .array(inputId)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length)
    .optional(),
  terminationDate: DateSchema.optional(),
  manualDeducts: z
    .array(manual)
    .refine((rows) => new Set(rows.map((r) => r.orderItemId)).size === rows.length)
    .optional(),
});
export const AdCancelQuoteBodySchema = OrderCancelQuoteBodySchema.pick({ reasonCode: true });
export const ReturnBreakdownSchema = z
  .strictObject({
    qty: points,
    backToOriginal: points,
    convertedToAddon: points,
    forfeited: points,
    lots: z.array(
      z.strictObject({
        lotKind: z.enum(["plan", "addon"]),
        expiresAt: InstantSchema.optional(),
        qty: points,
        route: z.enum(["original", "converted", "forfeited"]),
      }),
    ),
  })
  .refine((v) => v.qty === v.backToOriginal + v.convertedToAddon + v.forfeited);
export const CancelQuoteLineSchema = z
  .strictObject({
    targetType: z.enum(["order_item", "ad"]),
    targetId: IdSchema,
    label: z.string(),
    episodeCount: points.nullable(),
    productionModel: zodEnum(PRODUCTION_MODEL).nullable(),
    platforms: z.array(z.enum(["douyin", "wechat_channels"])),
    mode: z.enum(["release", "refund", "terminate_only"]),
    stage: zodEnum(CANCEL_REQUEST_LINE_STAGE),
    stepAtSubmit: z.string().nullable(),
    reasonClass: z.enum(["merchant", "platform", "qualification"]),
    chargePoints: points.positive(),
    priorRequestedPoints: points,
    ratioBp: z.int().min(0).max(10000).nullable(),
    isManualDeduct: z.boolean(),
    deductPoints: points,
    deductNote: z.string().nullable(),
    refundPoints: points,
    terminationDate: DateSchema.nullable(),
    usageStartDate: DateSchema.nullable(),
    usageEndDate: DateSchema.nullable(),
    usageEndSource: z.enum(["license", "early_end", "expired"]).nullable(),
    capturedAt: InstantSchema.nullable(),
    preview: ReturnBreakdownSchema,
  })
  .refine((v) => v.deductPoints + v.refundPoints === v.chargePoints - v.priorRequestedPoints);
export const CancelBlockReasonSchema = z.enum([
  "item_closed",
  "live_not_refundable",
  "item_expired",
  "in_other_request",
  "ad_confirmed",
  "ad_cancelled",
  "ad_in_use",
]);
export const CancelQuoteSchema = z.strictObject({
  quotedAt: InstantSchema,
  reasonCode: CancelReasonSchema,
  lines: z.array(CancelQuoteLineSchema),
  totalBasePoints: points,
  totalDeductPoints: points,
  totalRefundPoints: points,
  destination: ReturnBreakdownSchema,
  needsManualDeduct: z.boolean(),
  blockers: z.array(
    z.strictObject({ orderItemId: IdSchema.nullable(), reason: CancelBlockReasonSchema }),
  ),
  expect: z.strictObject({ totalRefundPoints: points }),
});
export const CancelRecheckEntrySchema = z.strictObject({
  at: InstantSchema,
  ok: z.boolean(),
  diffs: z.array(
    z.strictObject({
      lineId: IdSchema,
      field: z.string(),
      expected: z.unknown(),
      actual: z.unknown(),
    }),
  ),
});
export const FinalRejectImpactSchema = z.strictObject({
  pendingStartOrderCount: points,
  pendingAssignAdCount: points,
  heldPoints: points,
  orders: z.array(z.strictObject({ orderId: IdSchema, orderNo: z.string(), heldPoints: points })),
  ads: z.array(z.strictObject({ adId: IdSchema, adNo: z.string(), heldPoints: points })),
  computedAt: InstantSchema,
});
export type CancelReason = z.infer<typeof CancelReasonSchema>;
export type OrderCancelQuoteBody = z.infer<typeof OrderCancelQuoteBodySchema>;
export type AdCancelQuoteBody = z.infer<typeof AdCancelQuoteBodySchema>;
export type CancelQuoteLine = z.infer<typeof CancelQuoteLineSchema>;
export type CancelQuote = z.infer<typeof CancelQuoteSchema>;
export type CancelBlockReason = z.infer<typeof CancelBlockReasonSchema>;
export type CancelRecheckEntry = z.infer<typeof CancelRecheckEntrySchema>;
export type FinalRejectImpact = z.infer<typeof FinalRejectImpactSchema>;

// W2-10 内部写链命令；HTTP 与可选客服引用由后续应用用例接入。
const confirm = z.strictObject({ requestNo: z.string().min(1), totalRefundPoints: points });
const closeNote = z.string().trim().min(1).max(200);
export const AdCancelCoreSubmitBodySchema = z.strictObject({
  reasonCode: AdCancelQuoteBodySchema.shape.reasonCode,
  note: z.string().trim().min(5).max(200),
  expect: z.strictObject({ totalRefundPoints: points }),
});
export const CancelApproveBodySchema = z.strictObject({
  lockVersion: z.int().nonnegative(),
  confirm,
  confirmChecks: z.array(z.literal("stage_rule_amount_checked")).min(1),
});
export const CancelExecuteBodySchema = z.strictObject({
  confirm,
  confirmChecks: z.array(z.literal("order_points_checked")).min(1),
});
export const CancelRejectBodySchema = z.strictObject({
  note: closeNote,
  // 启用状态与“取消与退款驳回”场景由事务内字典守卫判定。
  reasonCodes: z.array(z.string().trim().min(1)).max(1).optional(),
});
export const CancelWithdrawBodySchema = z.strictObject({
  note: z.string().trim().max(200).optional(),
});
export const CancelVoidBodySchema = z.strictObject({ note: closeNote });
export type AdCancelCoreSubmitBody = z.infer<typeof AdCancelCoreSubmitBodySchema>;
export type CancelApproveBody = z.infer<typeof CancelApproveBodySchema>;
export type CancelExecuteBody = z.infer<typeof CancelExecuteBodySchema>;
export type CancelRejectBody = z.infer<typeof CancelRejectBodySchema>;
export type CancelWithdrawBody = z.infer<typeof CancelWithdrawBodySchema>;
export type CancelVoidBody = z.infer<typeof CancelVoidBodySchema>;
