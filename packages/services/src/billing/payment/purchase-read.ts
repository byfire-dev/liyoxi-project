import { orderRefundProjection } from "../refund/order-projection.js";
import { orderInvoiceFacts } from "../invoices/projection.js";
import { invoiceItemName } from "../invoices/parameters.js";
import {
  PaymentOrderDetailSchema,
  PaymentOrderAdminDetailSchema,
  TransferProofDetailSchema,
  TransferProofQueueItemSchema,
  fulfillResultSchema,
  ApprovalDecisionViewSchema,
} from "@liyoxi/contract";
import type { BillingOrder, TransferProof, Prisma } from "@liyoxi/db";
import { byEntity, hasPermission, satisfiesLevel } from "../../authz/index.js";
import type { DataScope, StaffContext } from "../../authz/index.js";
import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { openField } from "../../security/index.js";
import { calendarDate, startOfDay, addDays } from "@liyoxi/shared/time";
import { financeConfigAt } from "../finance-config/index.js";
import { formulaOf } from "../catalog/index.js";
import { getPurchasePolicy } from "../policy/index.js";
import type { PurchaseClient } from "../policy/index.js";
import { receiptForProof, transferCheckViews, TransferCheckResultSchema } from "./transfer-ocr.js";
import { z } from "zod";
import type { BillingPurchaseDeps } from "./purchase-context.js";
const firstConfirmView = z.strictObject({
  bankSerialRaw: z.string(),
  bankSerialNorm: z.string(),
  payerBank: z.string().nullable(),
  receivedAmountFen: z.int().positive(),
});
const title = (content: Awaited<ReturnType<typeof contentView>>) =>
  content.kind === "topup"
    ? `加购 ${content.points ?? 0} 积分`
    : `${content.planName ?? "套餐"} · ${content.months ?? 1} 个月`;
export const iso = (at: Date | null): string | null => at?.toISOString() ?? null;
export async function staffBrief(tx: Tx, id: string | null) {
  if (!id) return null;
  const s = await tx.staff.findUnique({
    where: { id },
    select: { id: true, staffNo: true, name: true, staffRoleKey: true, isLead: true, status: true },
  });
  return s
    ? {
        staffId: s.id,
        staffNo: s.staffNo,
        name: s.name,
        roleKey: s.staffRoleKey,
        isLead: s.isLead,
        status: s.status,
      }
    : null;
}
export async function entityRef(tx: Tx, entityId: string) {
  const e = await tx.entity.findUniqueOrThrow({
      where: { id: entityId },
      select: { name: true, verificationStatus: true },
    }),
    s = await tx.store.findFirst({
      where: { entityId, isPrimary: true },
      select: { id: true, name: true, deliveryManagerId: true },
    });
  return {
    entityId,
    name: e.name ?? "",
    primaryStoreId: s?.id ?? null,
    primaryStoreName: s?.name ?? null,
    storeCount: await tx.store.count({ where: { entityId, lifecycle: "active" } }),
    verificationStatus: e.verificationStatus,
    managerStaff: await staffBrief(tx, s?.deliveryManagerId ?? null),
  };
}
export async function orderInScope(tx: Tx, scope: DataScope, id: string) {
  const o = await tx.billingOrder.findFirst({ where: { id, ...byEntity(scope) } });
  if (!o) throw new AppError("NOT_FOUND");
  return o;
}
export async function proofInScope(tx: Tx, scope: DataScope, id: string) {
  const p = await tx.transferProof.findFirst({ where: { id, ...byEntity(scope) } });
  if (!p) throw new AppError("NOT_FOUND");
  return p;
}
export async function dictRef(tx: Tx, dictTypeKey: string, code: string | null) {
  if (code === null) return null;
  const item = await tx.dictItem.findFirst({
    where: { dictTypeKey, code },
    select: { name: true },
  });
  return { code, name: item?.name ?? code };
}
async function contentView(tx: Tx, o: BillingOrder) {
  const content = o.contentSnapshot as {
    kind: "plan" | "topup" | "upgrade";
    planId?: string;
    planName?: string;
    months?: number;
    monthlyPoints?: number;
    points?: number;
    packId?: string;
    payFen?: number;
    cyclePriceFen?: number;
  };
  const plan = content.planId
    ? await tx.plan.findUnique({ where: { id: content.planId }, select: { name: true } })
    : null;
  return {
    kind: content.kind,
    planId: content.planId ?? null,
    planName: content.planName ?? plan?.name ?? null,
    months: content.months ?? null,
    pointPackId: content.packId ?? null,
    points: content.kind === "topup" ? (content.points ?? null) : null,
    upgrade: null,
  };
}
async function formulaView(tx: Tx, o: BillingOrder) {
  if (o.formulaCode === null) return null;
  const args = o.formulaArgs as Record<string, number>;
  if (o.formulaCode === "plan_monthly")
    return formulaOf(args.monthlyFeeFen ?? 0, o.amountFen, args.months ?? 1);
  if (o.formulaCode === "plan_cycle")
    return { code: "plan_cycle", args, text: `${args.months} 个月` };
  if (o.formulaCode === "topup") return { code: "topup", args, text: `加购 ${args.points} 积分` };
  return { code: o.formulaCode, args, text: "" };
}
async function fulfillmentView(tx: Tx, o: BillingOrder) {
  if (o.fulfillmentStatus === "none") return null;
  const r = fulfillResultSchema.parse(o.fulfillmentResult);
  if (r.status === "blocked")
    return {
      effectiveAt: null,
      isQueuedBehindActive: false,
      term: null,
      points: null,
      status: r.status,
      termId: null,
      lotIds: [],
      reasonCode: r.reasonCode,
    };
  const term = r.termId
      ? await tx.subscriptionTerm.findUnique({
          where: { id: r.termId },
          include: { plan: { select: { name: true } } },
        })
      : null,
    content = o.contentSnapshot as {
      monthlyPoints?: number;
      topupPoints?: number;
      points?: number;
    };
  return {
    effectiveAt: r.effectiveAt,
    isQueuedBehindActive: r.queuedBehindActive,
    term: term
      ? {
          planName: term.plan.name,
          startDate: term.startDate.toISOString().slice(0, 10),
          endDate: term.endDate.toISOString().slice(0, 10),
        }
      : null,
    points: content.monthlyPoints ?? content.topupPoints ?? content.points ?? null,
    status: r.status,
    termId: r.termId,
    lotIds: r.lotIds,
    reasonCode: null,
  };
}
export async function merchantOrderView(
  tx: Tx,
  deps: Pick<BillingPurchaseDeps, "clock" | "config" | "keyring" | "wechatPay">,
  o: BillingOrder,
  client: PurchaseClient,
) {
  const content = await contentView(tx, o),
    proof = await tx.transferProof.findFirst({
      where: { billingOrderId: o.id },
      orderBy: { uploadNo: "desc" },
    }),
    finance = o.bankAccountFinanceConfigRevisionId
      ? await tx.financeConfigRevision.findUnique({
          where: { id: o.bankAccountFinanceConfigRevisionId },
        })
      : null,
    bank = finance?.payload as { accountName: string; bankName: string } | undefined,
    now = deps.clock.now(),
    policy = await getPurchasePolicy(
      tx,
      deps.config,
      o.entityId,
      now,
      client,
      o.type,
      o.amountFen,
      deps.wechatPay?.provider.configured ?? false,
    ),
    fulfillment = await fulfillmentView(tx, o);
  const invoice = await orderInvoiceFacts(tx, o, now);
  return PaymentOrderDetailSchema.parse({
    paymentOrderId: o.id,
    orderNo: o.orderNo,
    type: o.type,
    status: o.status,
    channel: o.channel,
    transferState: o.transferState,
    amountFen: o.amountFen,
    title: `开通${content.planName ?? "套餐"} · ${content.months ?? 1} 个月`,
    createdAt: iso(o.createdAt),
    paidAt: iso(o.paidAt),
    invoiceItemName: await invoiceItemName(tx, o.type, now, false),
    invoiceState: invoice.invoiceState,
    activeInvoiceRequest: invoice.activeInvoiceRequest,
    actions: [
      ...(o.channel === "wechat_jsapi" && o.status === "pending_payment"
        ? [
            "sync",
            "cancel",
            ...(now.getTime() < o.expiresAt.getTime() - 60000 ? ["wechat-prepay"] : []),
          ]
        : o.channel === "bank_transfer" &&
            ((o.status === "pending_payment" && now < o.expiresAt) ||
              (o.status === "pending_confirmation" && o.transferState === "proof_submitted"))
          ? [...(o.status === "pending_payment" ? ["cancel"] : []), "submit-proof"]
          : []),
      ...(invoice.invoiceState === "eligible" &&
      (await tx.entity.findUnique({ where: { id: o.entityId } }))?.verificationStatus === "verified"
        ? ["submit-invoice"]
        : []),
    ],
    paidAmountFen: o.paidAmountFen,
    refundedAmountFen: o.refundedAmountFen,
    fulfillmentStatus: o.fulfillmentStatus,
    formula: await formulaView(tx, o),
    content,
    expiresAt: iso(o.expiresAt),
    isConfirmingResult:
      o.channel === "wechat_jsapi" && o.status === "pending_payment" && now >= o.expiresAt,
    isProcessingReceipt:
      (o.status === "paid" && o.fulfillmentStatus === "blocked") ||
      (o.status === "cancelled" && o.hasOpenException),
    cancelledAt: iso(o.cancelledAt),
    cancelReason: o.cancelReason,
    refundedAt: iso(o.refundedAt),
    fulfillment: o.fulfillmentStatus === "done" ? fulfillment : null,
    bankAccount:
      finance && bank
        ? {
            accountName: bank.accountName,
            bankName: bank.bankName,
            accountNo: finance.accountNoEnc
              ? openField(
                  deps.keyring(),
                  "finance_config_revision.account_no_enc",
                  finance.accountNoEnc,
                )
              : null,
            accountNoMask: finance.accountNoMask ?? "",
            transferRemark: o.orderNo,
          }
        : null,
    latestTransferProof: proof
      ? {
          transferProofId: proof.id,
          uploadNo: proof.uploadNo,
          reviewStatus: proof.reviewStatus,
          uploadedAt: iso(proof.uploadedAt),
          dueAt: iso(proof.dueAt),
          reviewedAt: iso(proof.reviewedAt),
          rejectReason: await dictRef(tx, "reject_reason", proof.rejectReasonCode),
          rejectNote: proof.rejectNote,
        }
      : null,
    channels: o.status === "pending_payment" ? policy.channels : [],
  });
}
async function uploadedBy(tx: Tx, p: TransferProof) {
  if (p.uploadedByStaffId)
    return { type: "staff", name: (await staffBrief(tx, p.uploadedByStaffId))?.name ?? null };
  const u = p.uploadedByUserId
    ? await tx.merchantUser.findUnique({
        where: { id: p.uploadedByUserId },
        select: { displayName: true },
      })
    : null;
  return { type: "merchant", name: u?.displayName ?? null };
}
export async function proofQueueView(tx: Tx, deps: BillingPurchaseDeps, p: TransferProof) {
  const o = await tx.billingOrder.findUniqueOrThrow({ where: { id: p.billingOrderId } }),
    now = deps.clock.now();
  const checks = p.checkResult === null ? null : TransferCheckResultSchema.parse(p.checkResult);
  const checkIs = (key: string, results: readonly string[]) =>
    checks?.items.some((item) => item.key === key && results.includes(item.result)) === true;
  return TransferProofQueueItemSchema.parse({
    transferProofId: p.id,
    uploadNo: p.uploadNo,
    paymentOrderId: o.id,
    orderNo: o.orderNo,
    orderType: o.type,
    entity: await entityRef(tx, p.entityId),
    amountFen: o.amountFen,
    uploadedAt: iso(p.uploadedAt),
    uploadedBy: await uploadedBy(tx, p),
    dueAt: iso(p.dueAt),
    isOverdue: p.reviewStatus === "pending" && p.dueAt !== null && now > p.dueAt,
    hints: [
      calendarDate(p.uploadedAt) === calendarDate(now) ? "uploaded_today" : "uploaded_earlier",
      ...(p.firstConfirm !== null ? ["in_review"] : []),
      ...(checkIs("payer_name", ["fail"]) ? ["payer_name_mismatch"] : []),
      ...(checkIs("amount", ["fail"]) ? ["amount_mismatch"] : []),
      ...(checkIs("remark_order_no", ["warn", "fail"]) ? ["remark_missing_order_no"] : []),
    ],
    reviewStatus: p.reviewStatus,
    reviewedAt: iso(p.reviewedAt),
    reviewedBy: await staffBrief(tx, p.reviewedByStaffId),
  });
}
export async function proofDetailView(
  tx: Tx,
  deps: BillingPurchaseDeps,
  p: TransferProof,
  staff: StaffContext,
) {
  const o = await tx.billingOrder.findUniqueOrThrow({ where: { id: p.billingOrderId } }),
    content = await contentView(tx, o),
    entity = await tx.entity.findUniqueOrThrow({
      where: { id: p.entityId },
      select: { verificationStatus: true, name: true },
    }),
    file = await tx.fileObject.findUniqueOrThrow({
      where: { id: p.fileId },
      select: { mime: true, declaredMime: true },
    }),
    others = await tx.transferProof.findMany({
      where: { billingOrderId: o.id, id: { not: p.id } },
      orderBy: { uploadNo: "desc" },
    }),
    finance = await financeConfigAt(tx, deps.clock.now());
  let review: z.infer<typeof TransferProofDetailSchema>["review"] = null;
  if (p.reviewApprovalRequestId !== null) {
    if (!deps.approval) throw new AppError("INTERNAL");
    const detail = await deps.approval.get(tx, staff, p.reviewApprovalRequestId);
    const role = detail.requester
      ? await tx.staffRole.findUnique({ where: { key: detail.requester.roleKey } })
      : null;
    review = {
      ...ApprovalDecisionViewSchema.parse(detail),
      requestNo: detail.requestNo,
      requesterRoleName: role ? `${role.name}${detail.requester?.isLead ? "主管" : ""}` : null,
      confirmChecks: detail.confirmChecks,
    };
  }
  const receipt = await receiptForProof(tx, deps, p);
  const checks = transferCheckViews(p.checkResult, receipt, {
    entityName: entity.name,
    amountFen: o.amountFen,
    orderNo: o.orderNo,
    createdAt: o.createdAt,
  });
  const first = p.firstConfirm === null ? null : firstConfirmView.parse(p.firstConfirm);
  return TransferProofDetailSchema.parse({
    ...(await proofQueueView(tx, deps, p)),
    order: {
      title: title(content),
      formulaText: (await formulaView(tx, o))?.text ?? null,
      createdAt: iso(o.createdAt),
      expiresAt: iso(o.expiresAt),
      status: o.status,
      transferState: o.transferState,
      createdBy: await staffBrief(tx, o.createdByStaffId),
    },
    bizHints: [
      { code: "plan_starts_on_confirm", text: "开通时间以确认到账时间为准" },
      ...(entity.verificationStatus === "pending"
        ? [{ code: "qualification_in_review", text: "商家资质审核中" }]
        : []),
    ],
    fileId: p.fileId,
    fileMime: file.mime ?? file.declaredMime,
    ocr: { ...receipt, warnings: [...receipt.warnings] },
    checks,
    firstConfirm:
      first && review
        ? {
            bankSerialRaw: first.bankSerialRaw,
            payerBank: await dictRef(tx, "bank", first.payerBank),
            receivedAmountFen: first.receivedAmountFen,
            confirmedBy: review.requester,
            confirmedAt: review.submittedAt,
          }
        : null,
    review,
    rejectReason: await dictRef(tx, "reject_reason", p.rejectReasonCode),
    rejectNote: p.rejectNote,
    otherUploads: others.map((r) => ({
      transferProofId: r.id,
      uploadNo: r.uploadNo,
      reviewStatus: r.reviewStatus,
      uploadedAt: iso(r.uploadedAt),
    })),
    secondReviewThresholdFen: finance.controls.receiptSecondReviewFen,
    lockVersion: p.lockVersion,
    actions:
      p.reviewStatus === "pending" &&
      o.status === "pending_confirmation" &&
      o.transferState === "proof_submitted"
        ? [
            ...(hasPermission(staff, "finance.receipt.confirm") &&
            o.createdByStaffId !== staff.staff.id
              ? ["confirm"]
              : []),
            ...(hasPermission(staff, "finance.receipt.reject") ? ["reject"] : []),
          ]
        : p.reviewStatus === "pending" &&
            o.status === "pending_confirmation" &&
            o.transferState === "confirm_review" &&
            review
          ? [
              ...(review.actions.includes("approve-review") && o.createdByStaffId !== staff.staff.id
                ? ["approve-review"]
                : []),
              ...(review.actions.includes("reject-review") ? ["reject-review"] : []),
            ]
          : [],
  });
}
export function assertProofView(staff: StaffContext) {
  if (
    !satisfiesLevel(staff.moduleLevels.order, "view") &&
    !satisfiesLevel(staff.moduleLevels.finance, "view")
  )
    throw new AppError("PERMISSION_DENIED");
}
export function queueWhere(
  at: Date,
  tab: "pending" | "processed_today",
  q?: string,
): Prisma.TransferProofWhereInput {
  const date = calendarDate(at);
  return {
    ...(tab === "pending"
      ? { reviewStatus: "pending" }
      : {
          reviewStatus: { in: ["accepted", "rejected"] },
          reviewedAt: { gte: startOfDay(date), lt: startOfDay(addDays(date, 1)) },
        }),
    ...(q
      ? {
          OR: [
            { billingOrder: { orderNo: { contains: q, mode: "insensitive" } } },
            { entity: { name: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
}
export async function adminOrderView(
  tx: Tx,
  deps: BillingPurchaseDeps,
  o: BillingOrder,
  staff: StaffContext,
) {
  const content = await contentView(tx, o),
    proofs = await tx.transferProof.findMany({
      where: { billingOrderId: o.id },
      orderBy: { uploadNo: "desc" },
    }),
    paymentTxns = await tx.paymentTxn.findMany({
      where: { billingOrderId: o.id },
      orderBy: { attemptNo: "asc" },
    }),
    bank = o.bankAccountFinanceConfigRevisionId
      ? await tx.financeConfigRevision.findUnique({
          where: { id: o.bankAccountFinanceConfigRevisionId },
        })
      : null,
    bankPayload = bank?.payload as { accountName: string; bankName: string } | undefined,
    owner = o.placedByUserId
      ? await tx.merchantUser.findUnique({
          where: { id: o.placedByUserId },
          select: { id: true, displayName: true, phoneMask: true },
        })
      : null,
    store = o.storeId
      ? await tx.store.findUnique({ where: { id: o.storeId }, select: { id: true, name: true } })
      : null,
    logs = await tx.statusTransition.findMany({
      where: { machine: "billing_order", subjectId: o.id },
      orderBy: { occurredAt: "asc" },
    }),
    auditLogs = await tx.auditLog.findMany({
      where: { targetType: "billing_order", targetId: o.id },
      orderBy: { createdAt: "asc" },
    }),
    exceptions = await tx.paymentException.findMany({
      where: { billingOrderId: o.id, status: { in: ["open", "resolving"] } },
    });
  return PaymentOrderAdminDetailSchema.parse({
    paymentOrderId: o.id,
    orderNo: o.orderNo,
    createdAt: iso(o.createdAt),
    entity: await entityRef(tx, o.entityId),
    store: store ? { storeId: store.id, name: store.name } : null,
    type: o.type,
    title: title(content),
    contentNote: o.fulfillmentNote,
    amountFen: o.amountFen,
    paidAmountFen: o.paidAmountFen,
    refundedAmountFen: o.refundedAmountFen,
    channel: o.channel,
    status: o.status,
    transferState: o.transferState,
    fulfillmentStatus: o.fulfillmentStatus,
    statusNote:
      o.fulfillmentStatus === "blocked"
        ? "履约受阻"
        : o.transferState === "proof_submitted"
          ? "待财务确认"
          : o.transferState === "proof_rejected"
            ? "凭证被驳回"
            : null,
    hasOpenException: o.hasOpenException,
    source: o.source,
    pendingTransferProofId: proofs.find((p) => p.reviewStatus === "pending")?.id ?? null,
    actions:
      hasPermission(staff, "finance.receipt.confirm") &&
      o.status === "pending_confirmation" &&
      o.transferState === "proof_submitted"
        ? ["confirm"]
        : [],
    formula: await formulaView(tx, o),
    content,
    effectNote: o.channel === "bank_transfer" && !o.paidAt ? "开通时间以确认到账时间为准" : null,
    expiresAt: iso(o.expiresAt),
    paidAt: iso(o.paidAt),
    cancelledAt: iso(o.cancelledAt),
    refundedAt: iso(o.refundedAt),
    fulfilledAt: iso(o.fulfilledAt),
    cancelReason: o.cancelReason,
    fulfillment: await fulfillmentView(tx, o),
    placedBy: owner
      ? { merchantUserId: owner.id, displayName: owner.displayName, phoneMask: owner.phoneMask }
      : null,
    createdBy: await staffBrief(tx, o.createdByStaffId),
    contractNo: o.contractNo,
    clientPlatform: o.clientPlatform,
    clientVersion: o.clientVersion,
    bankAccount:
      bank && bankPayload
        ? {
            financeConfigRevisionId: bank.id,
            accountName: bankPayload.accountName,
            bankName: bankPayload.bankName,
            accountNoMask: bank.accountNoMask ?? "",
          }
        : null,
    paymentTxns: await Promise.all(
      paymentTxns.map(async (r) => ({
        paymentTransactionId: r.id,
        attemptNo: r.attemptNo,
        channel: r.channel,
        status: r.status,
        outTradeNo: r.outTradeNo,
        channelTxnNo: r.channelTxnNo,
        channelAmountFen: r.channelAmountFen,
        feeFen: r.feeFen,
        channelSuccessAt: iso(r.channelSuccessAt),
        isApplied: r.appliedAt !== null,
        refundedFen: r.refundedFen,
        reconState: r.reconState,
        payerName: r.channel === "bank_transfer" ? r.channelPayerRef : null,
        confirmedBy: await staffBrief(tx, r.confirmedByStaffId),
        reviewedBy: await staffBrief(tx, r.reviewedByStaffId),
      })),
    ),
    transferProofs: await Promise.all(
      proofs.map(async (r) => ({
        transferProofId: r.id,
        uploadNo: r.uploadNo,
        reviewStatus: r.reviewStatus,
        uploadedAt: iso(r.uploadedAt),
        reviewedAt: iso(r.reviewedAt),
        uploadedBy: await uploadedBy(tx, r),
      })),
    ),
    refundRequests: await orderRefundProjection(tx, staff.scope, o.id),
    invoice: (await orderInvoiceFacts(tx, o, deps.clock.now())).invoice,
    openExceptions: exceptions.map((r) => ({
      paymentExceptionId: r.id,
      exceptionNo: r.exceptionNo,
      kind: r.kind,
      status: r.status,
    })),
    logs: [
      ...(await Promise.all(
        logs.map(async (r) => ({
          at: r.occurredAt.toISOString(),
          actor:
            r.actorType === "staff"
              ? ((await staffBrief(tx, r.actorId))?.name ?? null)
              : r.actorType === "system"
                ? "系统"
                : "商家",
          action: r.event,
          note: r.note,
        })),
      )),
      ...auditLogs.map((r) => ({
        at: r.createdAt.toISOString(),
        actor: r.actorName,
        action: r.action,
        note: r.summary,
      })),
    ].sort((a, b) => a.at.localeCompare(b.at)),
    lockVersion: o.lockVersion,
  });
}
