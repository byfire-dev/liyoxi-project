import { z } from "../../zod.js";
import { IdSchema, InstantSchema, DateSchema, DictRefSchema } from "../../common/index.js";

const n = z.int().nonnegative();
const nullableTime = InstantSchema.nullable();
export const PurchaseChannelSchema = z.object({
  code: z.enum(["wechat_jsapi", "bank_transfer"]),
  isEnabled: z.boolean(),
  isRecommended: z.boolean(),
  hintKey: z.string().nullable(),
});
export const PurchasePolicySchema = z
  .object({
    mode: z.enum(["in_app", "offline_contract", "hidden"]),
    isPriceShown: z.boolean(),
    isPurchasePromptAllowed: z.boolean(),
    channels: z.array(PurchaseChannelSchema),
    copy: z.object({
      planNounKey: z.string(),
      pointsNounKey: z.string(),
      agreementKeys: z.array(z.string()),
      payButtonKey: z.string(),
    }),
  })
  .openapi("PurchasePolicy");
export const PlanBenefitsSchema = z.object({
  monthlyPoints: n,
  discountBp: n,
  productionModel: z.enum(["standard", "advanced", "top"]),
  schedulePriority: z.enum(["standard", "priority", "rush"]),
  maxStores: n,
  maxMembers: n.nullable(),
  hasMonthlyReport: z.boolean(),
});
export const PlanCardSchema = PlanBenefitsSchema.extend({
  planId: IdSchema,
  code: z.string(),
  name: z.string(),
  rank: n,
  isCurrent: z.boolean(),
  planRevisionId: IdSchema,
  monthlyFeeFen: n.nullable(),
  cyclePrices: z.array(z.object({ months: z.int().positive(), priceFen: z.int().positive() })),
}).openapi("PlanCard");
export const PlanListSchema = z.object({
  items: z.array(PlanCardSchema),
});
export const BillingFormulaSchema = z.object({
  code: z.enum(["plan_monthly", "plan_cycle", "plan_upgrade", "topup"]),
  args: z.record(z.string(), z.number()),
  text: z.string(),
});
export const PlanQuoteSchema = z
  .object({
    action: z.enum(["subscribe", "renew", "downgrade", "renew_upgrade", "upgrade"]),
    orderType: z.enum(["plan_new", "plan_renew", "plan_upgrade"]),
    planId: IdSchema,
    planRevisionId: IdSchema,
    planName: z.string(),
    fromPlanName: z.string().nullable(),
    months: z.int().positive().nullable(),
    payFen: z.int().positive(),
    formula: BillingFormulaSchema,
    effectiveMode: z.enum(["immediate", "next_term"]),
    newTerm: z.object({ startDate: DateSchema, endDate: DateSchema }).nullable(),
    firstGrantDate: DateSchema.nullable(),
    benefits: PlanBenefitsSchema,
    upgrade: z
      .object({
        currentTermEndDate: DateSchema,
        remainingDays: n,
        baseDays: n,
        remainingFullMonths: n,
        feeDeltaPerMonthFen: n,
        monthlyDeltaPoints: n,
        proratedFen: n,
        topupPoints: n,
      })
      .nullable(),
    downgradeImpact: z.object({ storesToRemove: n, membersToRemove: n }).nullable(),
    promo: z
      .object({ type: z.literal("previous_revision"), appliedRevisionId: IdSchema })
      .nullable(),
    validUntil: nullableTime,
    quotedAt: InstantSchema,
    policy: PurchasePolicySchema,
  })
  .openapi("PlanQuote");
export const PlanQuoteBodySchema = z.object({
  planId: IdSchema,
  months: z.int().positive().optional(),
  intent: z.enum(["upgrade_now", "renew_next_term"]).optional(),
});
export const PaymentOrderCreateBodySchema = PlanQuoteBodySchema.partial({ planId: true })
  .extend({
    pointPackId: IdSchema.optional(),
    channel: z.enum(["wechat_jsapi", "bank_transfer"]),
    expectAmountFen: z.int().positive(),
    agreementVersionIds: z.array(IdSchema).min(1).max(2),
    acknowledgedDowngradeImpact: z.object({ storesToRemove: n, membersToRemove: n }).optional(),
  })
  .superRefine((v, c) => {
    if (Boolean(v.planId) === Boolean(v.pointPackId))
      c.addIssue({ code: "custom", path: ["planId"], message: "套餐与积分包二选一" });
  });
export const PaymentOrderParamsSchema = z.object({ paymentOrderId: IdSchema });
export const TransferProofCreateBodySchema = z.object({ fileId: IdSchema });
export const BankAccountViewSchema = z.object({
  accountName: z.string(),
  bankName: z.string(),
  accountNo: z.string().nullable(),
  accountNoMask: z.string(),
  transferRemark: z.string(),
});
export const TransferProofViewSchema = z.object({
  transferProofId: IdSchema,
  uploadNo: z.int().positive(),
  reviewStatus: z.enum(["pending", "accepted", "rejected", "superseded"]),
  uploadedAt: InstantSchema,
  dueAt: nullableTime,
  reviewedAt: nullableTime,
  rejectReason: DictRefSchema.nullable(),
  rejectNote: z.string().nullable(),
});
export const PaymentOrderContentViewSchema = z.object({
  kind: z.enum(["plan", "upgrade", "topup"]),
  planId: IdSchema.nullable(),
  planName: z.string().nullable(),
  months: z.int().positive().nullable(),
  pointPackId: IdSchema.nullable(),
  points: n.nullable(),
  upgrade: z
    .object({
      fromPlanName: z.string(),
      remainingDays: n,
      topupPoints: n,
      validUntil: InstantSchema,
    })
    .nullable(),
});
export const FulfillmentViewSchema = z.object({
  effectiveAt: InstantSchema,
  isQueuedBehindActive: z.boolean(),
  term: z.object({ planName: z.string(), startDate: DateSchema, endDate: DateSchema }).nullable(),
  points: n.nullable(),
});
export const PaymentOrderDetailSchema = z
  .object({
    paymentOrderId: IdSchema,
    orderNo: z.string(),
    type: z.enum(["plan_new", "plan_renew", "plan_upgrade", "topup"]),
    status: z.enum(["pending_payment", "pending_confirmation", "paid", "cancelled", "refunded"]),
    channel: z.enum(["wechat_jsapi", "bank_transfer"]),
    transferState: z
      .enum(["awaiting_proof", "proof_submitted", "proof_rejected", "confirm_review"])
      .nullable(),
    amountFen: n,
    title: z.string(),
    createdAt: InstantSchema,
    paidAt: nullableTime,
    invoiceItemName: z.string().nullable(),
    invoiceState: z.enum(["eligible", "applying", "invoiced", "expired", "not_eligible"]),
    activeInvoiceRequest: z
      .object({ invoiceRequestId: IdSchema, requestNo: z.string(), status: z.string() })
      .nullable(),
    actions: z.array(z.string()),
    paidAmountFen: n,
    refundedAmountFen: n,
    fulfillmentStatus: z.enum(["none", "done", "blocked"]),
    formula: BillingFormulaSchema.nullable(),
    content: PaymentOrderContentViewSchema,
    expiresAt: InstantSchema,
    isConfirmingResult: z.boolean(),
    isProcessingReceipt: z.boolean(),
    cancelledAt: nullableTime,
    cancelReason: z.string().nullable(),
    refundedAt: nullableTime,
    fulfillment: FulfillmentViewSchema.nullable(),
    bankAccount: BankAccountViewSchema.nullable(),
    latestTransferProof: TransferProofViewSchema.nullable(),
    channels: z.array(PurchaseChannelSchema),
  })
  .openapi("PaymentOrderDetail");
export const PaymentOrderCreateResultSchema = PaymentOrderDetailSchema.extend({
  replayed: z.boolean(),
});
export const BillingWalletSchema = z
  .object({
    subscription: z.object({
      status: z.enum(["none", "active", "expired"]),
      isRefundPending: z.boolean(),
      plan: z.object({ planId: IdSchema, code: z.string(), name: z.string() }).nullable(),
      months: n.nullable(),
      startDate: DateSchema.nullable(),
      endDate: DateSchema.nullable(),
      endsAt: nullableTime,
      remainingDays: z.int().nullable(),
      benefits: PlanBenefitsSchema.nullable(),
      scheduledTerms: z.array(
        z.object({ planName: z.string(), months: n, startDate: DateSchema, endDate: DateSchema }),
      ),
    }),
    usage: z.object({
      storesUsed: n,
      storeLimit: n,
      seatsUsed: n,
      memberLimit: n.nullable(),
      limitReason: z.enum(["plan", "inactive"]),
    }),
    points: z.object({
      spendablePoints: n,
      planAvailablePoints: n,
      addonAvailablePoints: n,
      heldPoints: n,
      isAddonSuspended: z.boolean(),
      planGrantedThisTermPoints: n,
      planPointsExpireAt: nullableTime,
      lastExpired: z.object({ expiredPoints: n, expiredAt: InstantSchema }).nullable(),
    }),
    topUp: z.object({
      canTopUp: z.boolean(),
      blockReason: z.enum(["no_active_plan", "refund_in_progress", "not_offered"]).nullable(),
    }),
    rules: z.object({
      adUnitPoints: n,
      discountedAdUnitPoints: n.nullable(),
      adFreeRevisions: n,
      topModelSurchargeBp: n,
    }),
  })
  .openapi("Wallet");
export type PurchasePolicy = z.infer<typeof PurchasePolicySchema>;
export type PlanQuote = z.infer<typeof PlanQuoteSchema>;
export type PlanQuoteBody = z.infer<typeof PlanQuoteBodySchema>;
export type PaymentOrderCreateBody = z.infer<typeof PaymentOrderCreateBodySchema>;
export type PaymentOrderDetail = z.infer<typeof PaymentOrderDetailSchema>;
