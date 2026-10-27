import { createHash } from "node:crypto";
import {
  billingOrderContentSchema,
  BILLING_ORDER_TYPE,
  PAY_CHANNEL,
  zodEnum,
} from "@liyoxi/contract";
import type { PaymentExceptionResolveBody } from "@liyoxi/contract";
import type { StaffContext } from "../../../authz/index.js";
import { AppError } from "../../../kernel/index.js";
import type { IdentityContext, Tx } from "../../../kernel/index.js";
import type { WechatPayTransaction } from "../../../providers/types.js";
import { wechatOrderAttach } from "../channel-success.js";
import type { LockedException, PaymentExceptionDeps } from "./context.js";
import { fulfill, recordBlocked } from "./fulfill.js";

const invalid = () => new AppError("CHANNEL_RECHECK_FAILED");
/** 固定v1编码反解后必须重新编码相等；不接受宽松base64或外部任意JSON。 */
export function decodeAttach(value: string) {
  const parts = value.split(".");
  if (parts.length !== 6 || parts[0] !== "v1" || !["N", "R", "T"].includes(parts[3]!))
    throw invalid();
  const id = (raw: string) => {
    const data = Buffer.from(raw, "base64url");
    if (data.length !== 16 || data.toString("base64url") !== raw) throw invalid();
    const hex = data.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const months = Number(parts[5]);
  if (
    !Number.isSafeInteger(months) ||
    String(months) !== parts[5] ||
    (parts[3] === "T" ? months !== 0 : months <= 0)
  )
    throw invalid();
  return {
    entityId: id(parts[1]!),
    orderId: id(parts[2]!),
    type: parts[3] === "N" ? "plan_new" : parts[3] === "R" ? "plan_renew" : "topup",
    refId: id(parts[4]!),
    months,
  };
}
export async function rebuild(
  tx: Tx,
  deps: PaymentExceptionDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  state: LockedException,
  fact: WechatPayTransaction,
  input: PaymentExceptionResolveBody,
) {
  const receipt = state.receipt;
  if (
    !receipt ||
    state.order ||
    receipt.billingOrderId ||
    receipt.appliedAt ||
    receipt.refundedFen ||
    !fact.attach ||
    !fact.successAt ||
    !fact.payerOpenid ||
    !fact.amountFen
  )
    throw invalid();
  const original = decodeAttach(fact.attach);
  if (
    (receipt.entityId && receipt.entityId !== original.entityId) ||
    !(await tx.entity.findUnique({ where: { id: original.entityId } })) ||
    (await tx.billingOrder.findUnique({ where: { id: original.orderId } }))
  )
    throw invalid();
  const now = deps.clock.now();
  let raw: unknown;
  if (original.type === "topup") {
    const pack = await tx.pointPack.findUnique({ where: { id: original.refId } });
    // 可变积分包在付款后改过时无法证实原积分，不能据现值灾备造历史。
    if (
      !pack ||
      pack.createdAt > fact.successAt ||
      pack.updatedAt > fact.successAt ||
      pack.priceFen !== fact.amountFen
    )
      throw invalid();
    raw = { v: 1, kind: "topup", packId: pack.id, points: pack.points, payFen: pack.priceFen };
  } else {
    const revision = await tx.planRevision.findUnique({
      where: { id: original.refId },
      include: { plan: true },
    });
    const prices = revision?.cyclePrices;
    const price =
      prices && typeof prices === "object" && !Array.isArray(prices)
        ? prices[String(original.months)]
        : undefined;
    if (
      !revision ||
      revision.createdAt > fact.successAt ||
      revision.effectiveAt > fact.successAt ||
      (revision.cancelledAt && revision.cancelledAt <= fact.successAt) ||
      price !== fact.amountFen
    )
      throw invalid();
    raw = {
      v: 1,
      kind: "plan",
      planId: revision.planId,
      planName: revision.plan.name,
      planRevisionId: revision.id,
      months: original.months,
      cyclePriceFen: price,
      payFen: price,
      monthlyPoints: revision.monthlyPoints,
      discountBp: revision.discountBp,
      promo: null,
      quotedAt: now.toISOString(),
    };
  }
  const content = billingOrderContentSchema.parse(raw),
    quoted = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  const originalNo = /^(T?FK\d{13,})-\d{2}-[A-F0-9]{6}$/.exec(receipt.outTradeNo)?.[1];
  if (!originalNo) throw invalid();
  const orderNo = (await tx.billingOrder.findUnique({ where: { orderNo: originalNo } }))
    ? await deps.bizNo.next(tx, "FK")
    : originalNo;
  const order = await tx.billingOrder.create({
    data: {
      id: original.orderId,
      orderNo,
      entityId: original.entityId,
      storeId: null,
      type: original.type,
      status: "paid",
      source: "weapp",
      channel: "wechat_jsapi",
      contentSnapshot: content,
      quoteHash: quoted,
      amountFen: fact.amountFen,
      paidAmountFen: fact.amountFen,
      paidAt: fact.successAt,
      paidPaymentTxnId: receipt.id,
      appliedAt: now,
      expiresAt: now,
      rebuiltFrom: receipt.outTradeNo,
      createdByStaffId: staff.staff.id,
      hasOpenException: true,
      createdAt: now,
      updatedAt: now,
    },
  });
  if (wechatOrderAttach(order) !== fact.attach) throw invalid();
  await tx.paymentTxn.update({
    where: { id: receipt.id },
    data: {
      billingOrderId: order.id,
      entityId: order.entityId,
      payerOpenid: fact.payerOpenid,
      attach: fact.attach,
      appliedAt: now,
      updatedAt: now,
    },
  });
  await tx.paymentException.update({
    where: { id: state.exception.id },
    data: { billingOrderId: order.id, entityId: order.entityId, updatedAt: now },
  });
  await deps.flow.transition(tx, ctx, {
    machine: "billing_order",
    stateField: "status",
    id: order.id,
    event: "billing_order.rebuild",
    ref: "08:178",
    created: true,
    args: { paymentExceptionId: state.exception.id },
    entityId: order.entityId,
    audit: {
      stream: "ops",
      category: "recon",
      action: "finance.payment_exception.rebuild_order",
      summary: input.note,
      target: { type: "billing_order", id: order.id },
    },
    emit: {
      type: "billing_order.created",
      payload: {
        v: 1,
        billingOrderId: order.id,
        entityId: order.entityId,
        storeId: null,
        orderType: zodEnum(BILLING_ORDER_TYPE).parse(order.type),
        channel: zodEnum(PAY_CHANNEL).parse(order.channel),
        amountFen: order.amountFen,
      },
      dedupeKey: `billing_order.created:${order.id}`,
    },
  });
  await deps.events.emit(tx, ctx, {
    type: "billing_order.paid",
    aggregate: { type: "billing_order", id: order.id },
    entityId: order.entityId,
    storeId: null,
    payload: {
      v: 1,
      billingOrderId: order.id,
      entityId: order.entityId,
      storeId: null,
      orderType: zodEnum(BILLING_ORDER_TYPE).parse(order.type),
      channel: zodEnum(PAY_CHANNEL).parse(order.channel),
      amountFen: order.amountFen,
      paidPaymentTxnId: receipt.id,
      placedByUserId: null,
      fromState: null,
      toState: "paid",
      transition: "billing_order.rebuild",
    },
    dedupeKey: `billing_order.paid:${order.id}`,
  });
  const result = await fulfill(tx, deps, ctx, order, input);
  if (result.status === "blocked") await recordBlocked(tx, deps, ctx, order);
  return { order, result };
}
