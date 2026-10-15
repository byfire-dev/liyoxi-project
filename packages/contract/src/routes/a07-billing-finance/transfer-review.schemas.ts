// W4-04：a07 §3.43/3.44/3.50/3.51 的真实写入契约。
import { z } from "../../zod.js";
import { IdSchema } from "../../common/index.js";

export const AdminPaymentOrderCreateBodySchema = z
  .strictObject({
    entityId: IdSchema,
    storeId: IdSchema.optional(),
    kind: z.enum(["plan", "topup"]),
    planId: IdSchema.optional(),
    months: z.int().positive().optional(),
    intent: z.enum(["upgrade_now", "renew_next_term"]).optional(),
    pointPackId: IdSchema.optional(),
    expectAmountFen: z.int().positive(),
    contractNo: z.string().trim().min(1).max(64),
    confirm: z.strictObject({ entityName: z.string().min(1), amountFen: z.int().positive() }),
  })
  .superRefine((value, ctx) => {
    if (
      value.kind === "plan" &&
      (!value.planId || (value.intent !== "upgrade_now" && !value.months))
    )
      ctx.addIssue({ code: "custom", message: "套餐与周期必填" });
    if (value.kind === "topup" && !value.pointPackId)
      ctx.addIssue({ code: "custom", message: "积分包必填" });
    if (
      (value.kind === "plan" && value.pointPackId !== undefined) ||
      (value.kind === "topup" &&
        [value.planId, value.months, value.intent].some((v) => v !== undefined))
    )
      ctx.addIssue({ code: "custom", message: "付款类型与内容不一致" });
  })
  .openapi("AdminPaymentOrderCreateBody");
export const AdminTransferProofCreateBodySchema = z
  .strictObject({
    fileId: IdSchema,
    note: z.string().trim().max(200).optional(),
  })
  .openapi("AdminTransferProofCreateBody");
export const TransferProofApproveReviewBodySchema = z
  .strictObject({
    lockVersion: z.int().nonnegative(),
    confirm: z.strictObject({ orderNo: z.string().min(1), receivedAmountFen: z.int().positive() }),
    confirmChecks: z
      .array(z.string().min(1))
      .min(1)
      .max(10)
      .refine(
        (v) => new Set(v).size === v.length && v.includes("bank_statement_checked"),
        "请核对银行流水",
      ),
  })
  .openapi("TransferProofApproveReviewBody");
export const TransferProofRejectReviewBodySchema = z
  .strictObject({
    note: z.string().trim().min(1).max(200),
  })
  .openapi("TransferProofRejectReviewBody");
export type AdminPaymentOrderCreateBody = z.infer<typeof AdminPaymentOrderCreateBodySchema>;
export type AdminTransferProofCreateBody = z.infer<typeof AdminTransferProofCreateBodySchema>;
export type TransferProofApproveReviewBody = z.infer<typeof TransferProofApproveReviewBodySchema>;
export type TransferProofRejectReviewBody = z.infer<typeof TransferProofRejectReviewBodySchema>;
