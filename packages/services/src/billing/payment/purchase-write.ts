import { createHash } from "node:crypto";
import type {
  PaymentOrderCreateBody,
  TransferProofConfirmBody,
  TransferProofRejectBody,
} from "@liyoxi/contract";
import type { BillingOrder } from "@liyoxi/db";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import { AppError, lockRows, uuidv7, isUniqueViolation } from "../../kernel/index.js";
import { assertPermission } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { record } from "../../audit/index.js";
import { maskName } from "@liyoxi/shared/mask";
import { paramsAt } from "../../config/index.js";

import { quotePlan } from "../catalog/index.js";
import { assertTopupActor, quotePointPack } from "../catalog/point-packs.js";
import { financeConfigAt } from "../finance-config/index.js";
import { getPurchasePolicy } from "../policy/index.js";
import type { PurchaseClient } from "../policy/index.js";
import { merchantOrderView, orderInScope, proofInScope, proofDetailView } from "./purchase-read.js";
import type { BillingPurchaseDeps, PurchaseActor } from "./purchase-context.js";
import { armTransferTtl, cancelTransferSla } from "./transfer-sla.js";
import { assertTransferStaff, submitTransferProof } from "./transfer-admin.js";
import {
  normalizeBankSerial,
  checkBankSerial,
  lockBankSerial,
  acceptTransferProof,
  beginTransferReview,
} from "./transfer-review.js";
export { normalizeBankSerial } from "./transfer-review.js";

function owner(actor: PurchaseActor) {
  if (
    actor.ctx.actor.type !== "merchant" ||
    actor.ctx.actor.id === null ||
    actor.membership.role !== "owner" ||
    actor.ctx.actor.role !== "owner" ||
    actor.ctx.entityId !== actor.membership.entityId
  )
    throw new AppError("ROLE_FORBIDDEN");
}
async function validOwner(tx: Tx, deps: BillingPurchaseDeps, actor: PurchaseActor) {
  owner(actor);
  const current = await deps.tenant.resolveMembership(tx, {
    merchantUserId: actor.ctx.actor.id!,
    storeId: actor.membership.storeId,
  });
  if (current?.role !== "owner" || current.entityId !== actor.membership.entityId)
    throw new AppError("NOT_FOUND");
}
async function consents(
  tx: Tx,
  deps: BillingPurchaseDeps,
  actor: PurchaseActor,
  order: { id: string; orderNo: string },
  versions: readonly string[],
  scene: "plan_purchase" | "topup" = "plan_purchase",
) {
  const selected = await tx.agreementVersion.findMany({
    where: { id: { in: [...versions] } },
    select: { agreementKey: true },
  });
  const current = await deps.docs.currentVersions(tx);
  for (const agreementKey of scene === "topup" ? ["points"] : ["member", "points"]) {
    if (!selected.some((v) => v.agreementKey === agreementKey))
      throw new AppError("AGREEMENT_VERSION_STALE", {
        details: { agreementKey, currentAgreementVersionId: current.get(agreementKey)?.id ?? null },
      });
  }
  const user = await tx.merchantUser.findUniqueOrThrow({
      where: { id: actor.ctx.actor.id! },
      select: { phoneEnc: true, phoneMask: true, displayName: true },
    }),
    entity = await tx.entity.findUniqueOrThrow({
      where: { id: actor.membership.entityId },
      select: { name: true, usccEnc: true, usccMask: true },
    });
  await deps.docs.assertConsents(tx, actor.ctx, {
    scene,
    method: "by_action",
    consents: versions.map((agreementVersionId) => ({ agreementVersionId })),
    signer: {
      merchantUserId: actor.ctx.actor.id!,
      phoneEnc: user.phoneEnc!,
      phoneMask: user.phoneMask!,
      operatorNameMask: user.displayName ? maskName(user.displayName) : null,
      role: "owner",
      appid: null,
      openidHmac: null,
    },
    entity: {
      entityId: actor.membership.entityId,
      entityName: entity.name,
      usccEnc: entity.usccEnc,
      usccMask: entity.usccMask,
      storeId: actor.membership.storeId,
    },
    biz: { type: "billing_order", id: order.id, no: order.orderNo },
  });
}
export async function createOrder(
  tx: Tx,
  deps: BillingPurchaseDeps,
  actor: PurchaseActor,
  client: PurchaseClient,
  input: PaymentOrderCreateBody,
  stagingOnly = false,
) {
  owner(actor);
  if (
    stagingOnly &&
    (input.channel !== "wechat_jsapi" ||
      !input.planId ||
      input.pointPackId ||
      !Number.isInteger(input.expectAmountFen) ||
      input.expectAmountFen < 1 ||
      input.expectAmountFen > 100)
  )
    throw new AppError("PRECONDITION_CHANGED");
  await lockRows(tx, "entity", [actor.membership.entityId]);
  await validOwner(tx, deps, actor);
  const entity = await tx.entity.findUniqueOrThrow({ where: { id: actor.membership.entityId } });
  if (!["verified", "pending"].includes(entity.verificationStatus))
    throw new AppError("PURCHASE_QUALIFICATION_REQUIRED", {
      details: { verificationStatus: entity.verificationStatus },
    });
  if (Boolean(input.pointPackId) === Boolean(input.planId)) throw new AppError("VALIDATION_FAILED");
  const topup = input.pointPackId !== undefined;
  if (topup) await assertTopupActor(tx, deps, actor);
  // 在账户锁前定位可复用行并按290加锁；锁后仍重新读取目录与报价。
  const initialPack = topup
    ? await tx.pointPack.findUnique({ where: { id: input.pointPackId! } })
    : null;
  const initialHash = initialPack
    ? createHash("sha256")
        .update(
          JSON.stringify({
            v: 1,
            kind: "topup",
            packId: initialPack.id,
            points: initialPack.points,
            payFen: initialPack.priceFen,
          }),
        )
        .digest("hex")
    : null;
  const open = await tx.billingOrder.findFirst({
    where: {
      entityId: entity.id,
      ...(topup
        ? { type: "topup", quoteHash: initialHash ?? "missing", channel: input.channel }
        : { type: { in: ["plan_new", "plan_renew", "plan_upgrade"] } }),
      status: { in: ["pending_payment", "pending_confirmation"] },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (open) await lockRows(tx, "billing_order", [open.id]);
  if (stagingOnly && open) {
    // 先锁后回读；旧普通单/类型/金额不匹配不得先追加同意记录再拒绝。
    const locked = await tx.billingOrder.findUniqueOrThrow({ where: { id: open.id } });
    if (
      !/^TFK\d+$/.test(locked.orderNo) ||
      locked.entityId !== actor.membership.entityId ||
      locked.channel !== "wechat_jsapi" ||
      locked.status !== "pending_payment" ||
      !["plan_new", "plan_renew"].includes(locked.type) ||
      locked.amountFen < 1 ||
      locked.amountFen > 100 ||
      locked.amountFen !== input.expectAmountFen
    )
      throw new AppError("PRECONDITION_CHANGED");
  }
  const clock = await deps.ledger.lockAccount(tx, entity.id),
    now = clock.now;
  const policy = (type: string, amount: number) =>
    getPurchasePolicy(
      tx,
      deps.config,
      entity.id,
      now,
      client,
      type,
      amount,
      deps.wechatPay?.provider.configured ?? false,
    );
  const quoted = topup
    ? null
    : await quotePlan(
        tx,
        entity.id,
        now,
        {
          planId: input.planId!,
          ...(input.months === undefined ? {} : { months: input.months }),
          ...(input.intent === undefined ? {} : { intent: input.intent }),
        },
        policy,
      );
  const packQuote = topup
    ? await quotePointPack(tx, entity.id, input.pointPackId!, now, policy)
    : null;
  const content = packQuote?.content ?? quoted!.content,
    payFen = content.payFen,
    purchasePolicy = packQuote?.policy ?? quoted!.quote.policy,
    formula = packQuote
      ? {
          code: "topup",
          args: { points: packQuote.pack.points, priceFen: packQuote.pack.priceFen },
        }
      : quoted!.quote.formula,
    orderType = topup ? "topup" : quoted!.quote.orderType;
  if (
    stagingOnly &&
    (!["plan_new", "plan_renew"].includes(orderType) ||
      !Number.isInteger(payFen) ||
      payFen < 1 ||
      payFen > 100)
  )
    throw new AppError("PRECONDITION_CHANGED");
  const impact = quoted?.quote.downgradeImpact;
  if (impact && (impact.storesToRemove > 0 || impact.membersToRemove > 0)) {
    if (!input.acknowledgedDowngradeImpact)
      throw new AppError("VALIDATION_FAILED", {
        details: {
          fieldErrors: [
            {
              path: "acknowledgedDowngradeImpact",
              message: "请确认版本生效前需调整的门店和成员数量",
            },
          ],
        },
      });
    if (
      impact.storesToRemove !== input.acknowledgedDowngradeImpact.storesToRemove ||
      impact.membersToRemove !== input.acknowledgedDowngradeImpact.membersToRemove
    )
      throw new AppError("QUOTE_CHANGED", {
        details: { kind: "plan", amountFen: payFen, quote: quoted!.quote },
      });
  }
  if (payFen !== input.expectAmountFen)
    throw new AppError("QUOTE_CHANGED", {
      details: packQuote
        ? {
            kind: "topup",
            amountFen: payFen,
            pointPack: {
              pointPackId: packQuote.pack.id,
              points: packQuote.pack.points,
              priceFen: packQuote.pack.priceFen,
            },
          }
        : { kind: "plan", amountFen: payFen, quote: quoted!.quote },
    });
  if (!purchasePolicy.channels.find((c) => c.code === input.channel)?.isEnabled)
    throw new AppError("CHANNEL_NOT_ALLOWED", { details: { channels: purchasePolicy.channels } });
  const quoteHash = createHash("sha256")
    .update(
      JSON.stringify({
        ...content,
        quotedAt: undefined,
        ...(content.kind === "upgrade" ? { validUntil: undefined } : {}),
      }),
    )
    .digest("hex");
  if (open && (!topup || (open.quoteHash === quoteHash && open.channel === input.channel))) {
    if (open.quoteHash !== quoteHash || open.channel !== input.channel)
      throw new AppError("OPEN_ORDER_EXISTS", {
        details: { paymentOrderId: open.id, orderNo: open.orderNo },
      });
    if (open.expiresAt.getTime() - now.getTime() <= 300_000)
      throw new AppError("OPEN_ORDER_EXPIRING", {
        details: {
          paymentOrderId: open.id,
          orderNo: open.orderNo,
          expiresAt: open.expiresAt.toISOString(),
        },
      });
    await consents(
      tx,
      deps,
      actor,
      open,
      input.agreementVersionIds,
      topup ? "topup" : "plan_purchase",
    );
    return { ...(await merchantOrderView(tx, deps, open, client)), replayed: false };
  }
  const id = uuidv7(),
    orderNo = await deps.bizNo.next(tx, "FK");
  if (stagingOnly && !/^TFK\d+$/.test(orderNo)) throw new AppError("PRECONDITION_CHANGED");
  await consents(
    tx,
    deps,
    actor,
    { id, orderNo },
    input.agreementVersionIds,
    topup ? "topup" : "plan_purchase",
  );
  const createdAt = deps.clock.now();
  const finance = await financeConfigAt(tx, createdAt);
  if (input.channel === "bank_transfer" && !finance.bank)
    throw new AppError("CHANNEL_NOT_ALLOWED", { details: { channels: purchasePolicy.channels } });
  const params = await paramsAt(
      tx,
      ["billing.payment.transfer_valid_days", "billing.payment.order_timeout_minutes"],
      createdAt,
    ),
    expiresAt = new Date(
      createdAt.getTime() +
        (input.channel === "wechat_jsapi"
          ? params["billing.payment.order_timeout_minutes"] * 60_000
          : params["billing.payment.transfer_valid_days"] * 86_400_000),
    );
  if (content.kind === "upgrade") {
    const validUntil = new Date(content.validUntil).getTime();
    expiresAt.setTime(
      Math.min(expiresAt.getTime(), validUntil - (input.channel === "wechat_jsapi" ? 120_000 : 0)),
    );
    if (input.channel === "wechat_jsapi" && expiresAt.getTime() - createdAt.getTime() < 180_000)
      throw new AppError("UPGRADE_NOT_ALLOWED_TODAY", { details: { suggest: "renew_next_term" } });
  }
  const order = await tx.billingOrder.create({
    data: {
      id,
      orderNo,
      entityId: entity.id,
      storeId: actor.membership.storeId,
      type: orderType,
      status: "pending_payment",
      channel: input.channel,
      source: "weapp",
      contentSnapshot: content,
      formulaCode: formula.code,
      formulaArgs: formula.args,
      quoteHash,
      amountFen: payFen,
      expiresAt,
      transferState: input.channel === "bank_transfer" ? "awaiting_proof" : null,
      bankAccountFinanceConfigRevisionId:
        input.channel === "bank_transfer" ? finance.bank!.id : null,
      clientPlatform: client.platform,
      clientVersion: client.appVersion ?? null,
      placedByUserId: actor.ctx.actor.id,
      createdAt,
      updatedAt: createdAt,
    },
  });
  await deps.flow.transition(tx, actor.ctx, {
    machine: "billing_order",
    stateField: "status",
    id,
    event: "billing_order.create",
    ref: "08:162",
    created: true,
    args: { validated: true },
    audit: {
      stream: "activity",
      category: "payment",
      action: "billing.order.create",
      summary: input.channel === "bank_transfer" ? "创建对公付款单" : "创建微信付款单",
      target: { type: "billing_order", id },
      meta: {
        ...(input.channel === "bank_transfer" ? { collectionRevisionId: finance.bank!.id } : {}),
        ...(quoted?.quote.action === "downgrade"
          ? { acknowledgedDowngradeImpact: input.acknowledgedDowngradeImpact }
          : {}),
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
        channel: input.channel,
        amountFen: payFen,
      },
      dedupeKey: `billing_order.created:${id}`,
    },
  });
  if (input.channel === "bank_transfer") await armTransferTtl(tx, deps, order);
  else
    await deps.timers.arm(tx, {
      kind: "po.expire",
      subject: { type: "billing_order", id },
      fireAt: new Date(expiresAt.getTime() + 60_000),
      key: `po.expire:billing_order:${id}`,
      entityId: entity.id,
      storeId: actor.membership.storeId,
      payload: { expiresAt: expiresAt.toISOString() },
    });
  return { ...(await merchantOrderView(tx, deps, order, client)), replayed: false };
}
export async function submitProof(
  tx: Tx,
  deps: BillingPurchaseDeps,
  actor: PurchaseActor,
  client: PurchaseClient,
  id: string,
  fileId: string,
) {
  owner(actor);
  await lockRows(tx, "billing_order", [id]);
  const order = await tx.billingOrder.findFirst({
    where: { id, entityId: actor.membership.entityId },
  });
  if (!order) throw new AppError("NOT_FOUND");
  await validOwner(tx, deps, actor);
  await submitTransferProof(
    tx,
    deps,
    actor.ctx,
    order,
    { fileId },
    { type: "merchant", id: actor.ctx.actor.id! },
  );
  return merchantOrderView(
    tx,
    deps,
    await tx.billingOrder.findUniqueOrThrow({ where: { id } }),
    client,
  );
}
async function audit(
  tx: Tx,
  ctx: IdentityContext,
  action:
    | "billing.transfer_proof.submit"
    | "billing.transfer_proof.confirm"
    | "billing.transfer_proof.reject",
  id: string,
  summary: string,
  meta?: Record<string, unknown>,
) {
  await record(
    tx,
    ctx.actor,
    {
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      authMethod: null,
      sessionId: null,
    },
    {
      stream: ctx.actor.type === "merchant" ? "activity" : "ops",
      category: "payment",
      action,
      summary,
      target: { type: "transfer_proof", id },
      ...(ctx.entityId
        ? { entityId: ctx.entityId, storeId: ctx.storeId }
        : { entityId: null, storeId: null }),
      ...(meta ? { meta } : {}),
    },
  );
}
async function assertConfirmation(
  tx: Tx,
  deps: BillingPurchaseDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  order: BillingOrder,
  input: TransferProofConfirmBody,
) {
  assertPermission(staff, "finance.receipt.confirm", deps.clock.now());
  if (ctx.actor.type !== "staff" || ctx.actor.id !== staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  if (input.confirm.orderNo !== order.orderNo) throw new AppError("CONFIRM_MISMATCH");
  if (input.confirm.receivedAmountFen !== order.amountFen)
    throw new AppError("TRANSFER_AMOUNT_MISMATCH", { details: { amountFen: order.amountFen } });
  if (!input.confirmChecks.includes("bank_statement_checked"))
    throw new AppError("VALIDATION_FAILED");
  if (order.createdByStaffId === staff.staff.id) throw new AppError("CONFIRMER_IS_ORDER_CREATOR");
  const finance = await financeConfigAt(tx, deps.clock.now());
  return (
    finance.controls.receiptSecondReviewFen !== null &&
    order.amountFen >= finance.controls.receiptSecondReviewFen
  );
}
export async function confirmProof(
  tx: Tx,
  deps: BillingPurchaseDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  input: TransferProofConfirmBody,
) {
  await assertTransferStaff(tx, deps, ctx, staff, "finance.receipt.confirm");
  const first = await proofInScope(tx, staff.scope, id);
  await lockRows(tx, "billing_order", [first.billingOrderId]);
  const order = await orderInScope(tx, staff.scope, first.billingOrderId);
  const before = await proofInScope(tx, staff.scope, id);
  if (before.lockVersion !== input.lockVersion)
    throw new AppError("VERSION_CONFLICT", { details: { lockVersion: before.lockVersion } });
  if (
    before.reviewStatus !== "pending" ||
    order.status !== "pending_confirmation" ||
    order.transferState !== "proof_submitted"
  )
    throw new AppError("STATE_NOT_ALLOWED");
  const needsReview = await assertConfirmation(tx, deps, ctx, staff, order, input);
  let result;
  if (needsReview) {
    if (!deps.approval) throw new AppError("INTERNAL");
    const serial = normalizeBankSerial(input.bankSerialNo);
    await lockBankSerial(tx, serial);
    await checkBankSerial(tx, serial, input);
    await lockRows(tx, "transfer_proof", [id]);
    const proof = await proofInScope(tx, staff.scope, id);
    if (proof.lockVersion !== input.lockVersion || proof.reviewStatus !== "pending")
      throw new AppError("VERSION_CONFLICT");
    result = await beginTransferReview(tx, deps, deps.approval, ctx, staff, proof, order, input);
  } else {
    await acceptTransferProof(tx, deps, ctx, {
      proof: before,
      input,
      confirmedByStaffId: staff.staff.id,
    });
    result = {
      ...(await proofDetailView(tx, deps, await proofInScope(tx, staff.scope, id), staff)),
      outcome: "paid" as const,
    };
  }
  await audit(
    tx,
    { ...ctx, entityId: order.entityId, storeId: order.storeId },
    "billing.transfer_proof.confirm",
    id,
    needsReview ? "提交到账二人复核" : "确认到账",
    { confirm: input.confirm, confirmChecks: input.confirmChecks },
  );
  return result;
}
export async function rejectProof(
  tx: Tx,
  deps: BillingPurchaseDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  input: TransferProofRejectBody,
) {
  if (ctx.actor.type !== "staff" || ctx.actor.id !== staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  assertPermission(staff, "finance.receipt.reject", deps.clock.now());
  const first = await proofInScope(tx, staff.scope, id);
  await lockRows(tx, "billing_order", [first.billingOrderId]);
  await lockRows(tx, "transfer_proof", [id]);
  const proof = await proofInScope(tx, staff.scope, id),
    order = await orderInScope(tx, staff.scope, proof.billingOrderId),
    now = deps.clock.now();
  if (proof.lockVersion !== input.lockVersion)
    throw new AppError("VERSION_CONFLICT", { details: { lockVersion: proof.lockVersion } });
  if (
    proof.reviewStatus !== "pending" ||
    order.status !== "pending_confirmation" ||
    order.transferState !== "proof_submitted"
  )
    throw new AppError("STATE_NOT_ALLOWED");
  const reason = await tx.dictItem.findFirst({
    where: { dictTypeKey: "reject_reason", code: input.reasonCode, isEnabled: true },
  });
  if (!reason || (reason.ext as { scene?: string }).scene !== "transfer")
    throw new AppError("DICT_ITEM_DISABLED");
  if (!input.note.trim() || input.note.length > 200) throw new AppError("VALIDATION_FAILED");
  const params = await paramsAt(tx, ["billing.payment.transfer_valid_days"], now),
    expiresAt =
      order.type === "plan_upgrade"
        ? order.expiresAt
        : new Date(now.getTime() + params["billing.payment.transfer_valid_days"] * 86_400_000);
  await tx.transferProof.update({
    where: { id },
    data: {
      reviewStatus: "rejected",
      rejectReasonCode: input.reasonCode,
      rejectNote: input.note,
      reviewedByStaffId: staff.staff.id,
      reviewedAt: now,
      lockVersion: { increment: 1 },
      updatedAt: now,
    },
  });
  await cancelTransferSla(tx, deps.timers, id);
  await deps.flow.transition(
    tx,
    { ...ctx, entityId: order.entityId, storeId: order.storeId },
    {
      machine: "billing_order",
      stateField: "status",
      id: order.id,
      event: "billing_order.reject_proof",
      set: { transfer_state: "proof_rejected", expires_at: expiresAt },
      args: { transferProofId: id },
      audit: {
        stream: "ops",
        category: "payment",
        action: "billing.transfer_proof.reject",
        summary: "驳回对公凭证",
        target: { type: "transfer_proof", id },
      },
      emit: { none: true, primary: "transfer.rejected" },
    },
  );
  await deps.events.emit(tx, ctx, {
    type: "transfer.rejected",
    payload: {
      v: 1,
      transferProofId: id,
      billingOrderId: order.id,
      entityId: order.entityId,
      reasonCodes: [input.reasonCode],
    },
    aggregate: { type: "transfer_proof", id },
    dedupeKey: `transfer.rejected:${id}`,
  });
  await armTransferTtl(tx, deps, { ...order, expiresAt });
  return proofDetailView(
    tx,
    deps,
    await tx.transferProof.findUniqueOrThrow({ where: { id } }),
    staff,
  );
}
export const isSerialConflict = (e: unknown) =>
  isUniqueViolation(e, ["uq_payment_txn_channel_txn_no"]);
