// W4-04：后台线下开单复用真实报价，绝不伪造商家身份或协议同意。
import { createHash } from "node:crypto";
import { Prisma } from "@liyoxi/db";
import type { BillingOrder } from "@liyoxi/db";
import type {
  AdminPaymentOrderCreateBody,
  AdminTransferProofCreateBody,
  PurchasePolicy,
} from "@liyoxi/contract";
import { AppError, lockRows, uuidv7 } from "../../kernel/index.js";
import type { Tx, IdentityContext } from "../../kernel/index.js";
import { assertPermission, byEntity } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { record } from "../../audit/index.js";
import { paramsAt } from "../../config/index.js";
import { workHoursAt } from "../../sla/index.js";
import { quotePlan } from "../catalog/index.js";
import { quotePointPack } from "../catalog/point-packs.js";
import { financeConfigAt } from "../finance-config/index.js";
import { adminOrderView, orderInScope, proofDetailView } from "./purchase-read.js";
import type { BillingPurchaseDeps } from "./purchase-context.js";
import { armTransferTtl } from "./transfer-sla.js";
import { armTransferSla, cancelTransferSla } from "./transfer-sla.js";

export async function assertTransferStaff(
  tx: Tx,
  deps: BillingPurchaseDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  permission: "order.payment.create_offline" | "finance.receipt.confirm",
  skipStepUp = false,
) {
  if (ctx.actor.type !== "staff" || ctx.actor.id !== staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  assertPermission(staff, permission, deps.clock.now(), { skipStepUp });
  await lockRows(tx, "staff", [staff.staff.id], "share");
  const current = await tx.staff.findUnique({ where: { id: staff.staff.id } });
  if (
    !current ||
    current.status !== "active" ||
    current.staffRoleKey !== staff.staff.roleKey ||
    current.staffGroupId !== staff.staff.staffGroupId ||
    current.isLead !== staff.staff.isLead
  )
    throw new AppError("PERMISSION_DENIED");
}
/** 仅经显式后台开单权限/受控开关后传给真实报价器；不消费小程序购买入口策略。 */
const offlinePolicy = async (): Promise<PurchasePolicy> => ({
  mode: "in_app",
  isPriceShown: true,
  isPurchasePromptAllowed: true,
  channels: [{ code: "bank_transfer", isEnabled: true, isRecommended: true, hintKey: null }],
  copy: { planNounKey: "", pointsNounKey: "", agreementKeys: [], payButtonKey: "" },
});
export async function createAdminOrder(
  tx: Tx,
  deps: BillingPurchaseDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  input: AdminPaymentOrderCreateBody,
) {
  await assertTransferStaff(tx, deps, ctx, staff, "order.payment.create_offline");
  await lockRows(tx, "entity", [input.entityId]);
  const entity = await tx.entity.findFirst({
    where: { id: input.entityId, ...byEntity(staff.scope).entity },
  });
  if (!entity) throw new AppError("NOT_FOUND");
  if (
    input.storeId &&
    !(await tx.store.findFirst({
      where: { id: input.storeId, entityId: entity.id, lifecycle: "active" },
    }))
  )
    throw new AppError("NOT_FOUND");
  if (!["verified", "pending"].includes(entity.verificationStatus))
    throw new AppError("PURCHASE_QUALIFICATION_REQUIRED", {
      details: { verificationStatus: entity.verificationStatus },
    });
  const open =
    input.kind === "plan"
      ? await tx.billingOrder.findFirst({
          where: {
            entityId: entity.id,
            type: { in: ["plan_new", "plan_renew", "plan_upgrade"] },
            status: { in: ["pending_payment", "pending_confirmation"] },
          },
        })
      : null;
  if (open) {
    await lockRows(tx, "billing_order", [open.id]);
    throw new AppError("OPEN_ORDER_EXISTS", {
      details: { paymentOrderId: open.id, orderNo: open.orderNo },
    });
  }
  const { now } = await deps.ledger.lockAccount(tx, entity.id);
  const finance = await financeConfigAt(tx, now);
  if (!finance.controls.adminCreateOrder) throw new AppError("OFFLINE_ORDER_DISABLED");
  if (!finance.bank) throw new AppError("BANK_ACCOUNT_NOT_CONFIGURED");
  const quoted =
    input.kind === "plan"
      ? await quotePlan(
          tx,
          entity.id,
          now,
          {
            planId: input.planId!,
            ...(input.months === undefined ? {} : { months: input.months }),
            ...(input.intent === undefined ? {} : { intent: input.intent }),
          },
          offlinePolicy,
        )
      : null;
  const pack =
    input.kind === "topup"
      ? await quotePointPack(tx, entity.id, input.pointPackId!, now, offlinePolicy)
      : null;
  const content = pack?.content ?? quoted!.content,
    amountFen = content.payFen;
  if (input.expectAmountFen !== amountFen)
    throw new AppError("QUOTE_CHANGED", {
      details: pack
        ? {
            kind: "topup",
            amountFen,
            pointPack: {
              pointPackId: pack.pack.id,
              points: pack.pack.points,
              priceFen: pack.pack.priceFen,
            },
          }
        : { kind: "plan", amountFen, quote: quoted!.quote },
    });
  if (input.confirm.entityName !== entity.name || input.confirm.amountFen !== amountFen)
    throw new AppError("CONFIRM_MISMATCH");
  const createdAt = deps.clock.now();
  // 对公收款账户取保存时刻，避免报价后跨过已公告的财务修订。
  const current = await financeConfigAt(tx, createdAt);
  if (!current.controls.adminCreateOrder) throw new AppError("OFFLINE_ORDER_DISABLED");
  if (!current.bank) throw new AppError("BANK_ACCOUNT_NOT_CONFIGURED");
  const values = await paramsAt(tx, ["billing.payment.transfer_valid_days"], createdAt);
  const lifetime = createdAt.getTime() + values["billing.payment.transfer_valid_days"] * 86_400_000;
  const expiresAt = new Date(
    Math.min(
      lifetime,
      quoted?.quote.validUntil ? new Date(quoted.quote.validUntil).getTime() : lifetime,
    ),
  );
  const id = uuidv7(),
    orderNo = await deps.bizNo.next(tx, "FK");
  const orderType = quoted?.quote.orderType ?? "topup";
  const order = await tx.billingOrder.create({
    data: {
      id,
      orderNo,
      entityId: entity.id,
      storeId: input.storeId ?? null,
      type: orderType,
      status: "pending_payment",
      channel: "bank_transfer",
      source: "admin",
      createdByStaffId: staff.staff.id,
      contractNo: input.contractNo,
      contentSnapshot: content,
      formulaCode: pack ? "topup" : quoted!.quote.formula.code,
      formulaArgs: pack
        ? { points: pack.pack.points, priceFen: pack.pack.priceFen }
        : quoted!.quote.formula.args,
      quoteHash: createHash("sha256")
        .update(JSON.stringify({ ...content, quotedAt: undefined }))
        .digest("hex"),
      amountFen,
      expiresAt,
      transferState: "awaiting_proof",
      bankAccountFinanceConfigRevisionId: current.bank.id,
      createdAt,
      updatedAt: createdAt,
    },
  });
  await deps.flow.transition(tx, ctx, {
    machine: "billing_order",
    stateField: "status",
    id,
    event: "billing_order.create",
    ref: "08:163",
    created: true,
    entityId: entity.id,
    storeId: order.storeId,
    audit: {
      stream: "ops",
      category: "payment",
      action: "billing.order.create",
      summary: "线下合同开单",
      target: { type: "billing_order", id },
      entityId: entity.id,
      storeId: order.storeId,
      meta: {
        contractNo: input.contractNo,
        collectionRevisionId: current.bank.id,
        confirm: input.confirm,
      },
    },
    emit: {
      type: "billing_order.created",
      payload: {
        v: 1,
        billingOrderId: id,
        entityId: entity.id,
        storeId: order.storeId,
        orderType,
        channel: "bank_transfer",
        amountFen,
      },
      dedupeKey: `billing_order.created:${id}`,
    },
  });
  await armTransferTtl(tx, deps, order);
  return adminOrderView(tx, deps, order, staff);
}
export async function submitTransferProof(
  tx: Tx,
  deps: BillingPurchaseDeps,
  ctx: IdentityContext,
  order: BillingOrder,
  input: { fileId: string; note?: string },
  uploader: { type: "staff" | "merchant"; id: string },
) {
  const now = deps.clock.now();
  if (
    order.channel !== "bank_transfer" ||
    !(
      (order.status === "pending_payment" &&
        ["awaiting_proof", "proof_rejected"].includes(order.transferState ?? "")) ||
      (order.status === "pending_confirmation" &&
        ["proof_submitted", "confirm_review"].includes(order.transferState ?? ""))
    )
  )
    throw new AppError("STATE_NOT_ALLOWED");
  if (order.transferState === "confirm_review") throw new AppError("TRANSFER_PROOF_LOCKED");
  if (order.status === "pending_payment" && order.expiresAt <= now)
    throw new AppError("PAYMENT_ORDER_EXPIRED");
  const old = await tx.transferProof.findFirst({
    where: { billingOrderId: order.id, reviewStatus: "pending" },
  });
  if (old) await lockRows(tx, "transfer_proof", [old.id]);
  await lockRows(tx, "file_object", [input.fileId]);
  const file = await tx.fileObject.findUnique({ where: { id: input.fileId } });
  if (
    !file ||
    file.status !== "stored" ||
    file.category !== "pay_receipt" ||
    file.scopeType !== "entity" ||
    file.entityId !== order.entityId ||
    file.uploadActorType !== uploader.type ||
    file.uploadActorId !== uploader.id ||
    ((file.mime ?? file.declaredMime).startsWith("image/") &&
      (file.sizeBytes ?? file.declaredSize) > 5_242_880n) ||
    !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(
      file.mime ?? file.declaredMime,
    )
  )
    throw new AppError("FILE_NOT_USABLE");
  const values = await paramsAt(tx, ["sla.review.transfer_proof"], now),
    policy = values["sla.review.transfer_proof"];
  const due =
    policy === null
      ? null
      : await deps.sla.dueAt(tx, {
          policy: "review.transfer_proof",
          amount: policy.amount,
          unit: policy.unit,
          from: now,
          workHours: await workHoursAt(tx, now),
        });
  if (old) {
    await tx.transferProof.update({
      where: { id: old.id },
      data: { reviewStatus: "superseded", lockVersion: { increment: 1 }, updatedAt: now },
    });
    await cancelTransferSla(tx, deps.timers, old.id);
  }
  const last = await tx.transferProof.aggregate({
    where: { billingOrderId: order.id },
    _max: { uploadNo: true },
  });
  const id = uuidv7();
  const proof = await tx.transferProof.create({
    data: {
      id,
      entityId: order.entityId,
      billingOrderId: order.id,
      uploadNo: (last._max.uploadNo ?? 0) + 1,
      fileId: file.id,
      ...(uploader.type === "staff"
        ? { uploadedByStaffId: uploader.id }
        : { uploadedByUserId: uploader.id }),
      uploadedAt: now,
      reviewStatus: "pending",
      dueAt: due?.dueAt ?? null,
      slaSnapshot: due ? { ...due.snapshot } : Prisma.DbNull,
      createdAt: now,
      updatedAt: now,
    },
  });
  await deps.media.link(tx, {
    fileId: file.id,
    refType: "transfer_proof",
    refId: id,
    role: "main",
    entityId: order.entityId,
    storeId: null,
  });
  await armTransferSla(tx, deps, proof);
  const scoped = { ...ctx, entityId: order.entityId, storeId: order.storeId };
  if (order.status === "pending_payment")
    await deps.flow.transition(tx, scoped, {
      machine: "billing_order",
      stateField: "status",
      id: order.id,
      event: "billing_order.submit_proof",
      ref: "08:167",
      set: { transfer_state: "proof_submitted" },
      args: { transferProofId: id },
      audit: {
        stream: uploader.type === "staff" ? "ops" : "activity",
        category: "payment",
        action: "billing.transfer_proof.submit",
        summary: "提交对公凭证",
        target: { type: "transfer_proof", id },
        meta: { note: input.note ?? null },
      },
      emit: { none: true, primary: "transfer.proof_submitted" },
    });
  else
    await record(
      tx,
      scoped.actor,
      {
        requestId: scoped.requestId,
        ip: scoped.ip,
        userAgent: scoped.userAgent,
        authMethod: null,
        sessionId: null,
      },
      {
        stream: uploader.type === "staff" ? "ops" : "activity",
        category: "payment",
        action: "billing.transfer_proof.submit",
        summary: "替换对公凭证",
        target: { type: "transfer_proof", id },
        entityId: order.entityId,
        storeId: order.storeId,
        meta: { note: input.note ?? null },
      },
    );
  await deps.events.emit(tx, scoped, {
    type: "transfer.proof_submitted",
    aggregate: { type: "transfer_proof", id },
    payload: {
      v: 1,
      transferProofId: id,
      billingOrderId: order.id,
      entityId: order.entityId,
      dueAt: due?.dueAt.toISOString() ?? null,
    },
    dedupeKey: `transfer.proof_submitted:${id}`,
  });
  return proof;
}
export async function createAdminTransferProof(
  tx: Tx,
  deps: BillingPurchaseDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  orderId: string,
  input: AdminTransferProofCreateBody,
) {
  await assertTransferStaff(tx, deps, ctx, staff, "finance.receipt.confirm");
  await orderInScope(tx, staff.scope, orderId);
  await lockRows(tx, "billing_order", [orderId]);
  const order = await orderInScope(tx, staff.scope, orderId);
  const proof = await submitTransferProof(tx, deps, ctx, order, input, {
    type: "staff",
    id: staff.staff.id,
  });
  return proofDetailView(tx, deps, proof, staff);
}
