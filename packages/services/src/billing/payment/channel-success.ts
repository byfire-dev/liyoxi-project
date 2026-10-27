// 渠道事实唯一窄入口：只接已经验签的查单事实；不改付款单、不自行履约。
import { billingOrderContentSchema } from "@liyoxi/contract";
import type { BillingOrder, PaymentTxn } from "@liyoxi/db";
import { AppError, lockRows, uuidv7 } from "../../kernel/index.js";
import type { Clock, IdentityContext, Tx } from "../../kernel/index.js";
import { openPaymentException } from "./exception.js";
import type { PaymentDeps } from "./types.js";
import type { Events } from "../../events/index.js";
import type { WechatPayTransaction } from "../../providers/types.js";

export async function recordChannelSuccess(
  tx: Tx,
  deps: {
    clock: Clock;
    events: Pick<Events, "emit">;
    appid: string;
    mchid: string;
    exceptions?: Pick<PaymentDeps, "clock" | "bizNo" | "flow">;
    detectedBy?: "callback" | "query";
  },
  ctx: IdentityContext,
  input: { transaction: WechatPayTransaction } & (
    | { paymentTxnId: string; recover?: never }
    | { paymentTxnId?: never; recover: { order: BillingOrder | null; attemptNo: number } }
  ),
): Promise<{ paymentTxnId: string; replayed: boolean; conflict?: boolean }> {
  const fact = input.transaction;
  let created = false;
  let first = input.paymentTxnId
    ? await tx.paymentTxn.findUnique({ where: { id: input.paymentTxnId } })
    : await tx.paymentTxn.findUnique({ where: { outTradeNo: fact.outTradeNo } });
  if (!first && input.recover) {
    const recovery = input.recover;
    if (recovery.order) await lockRows(tx, "billing_order", [recovery.order.id]);
    if (
      !Number.isInteger(recovery.attemptNo) ||
      recovery.attemptNo < 1 ||
      recovery.attemptNo > 99 ||
      !Number.isSafeInteger(fact.amountFen) ||
      !fact.amountFen ||
      fact.amountFen < 1 ||
      fact.amountFen > 2_147_483_647 ||
      fact.tradeState !== "SUCCESS" ||
      !fact.transactionId ||
      !fact.payerOpenid ||
      fact.appid !== deps.appid ||
      fact.mchid !== deps.mchid ||
      !fact.successAt ||
      !Number.isFinite(fact.successAt.getTime()) ||
      fact.successAt > deps.clock.now() ||
      (recovery.order &&
        (recovery.order.channel !== "wechat_jsapi" ||
          !fact.outTradeNo.startsWith(`${recovery.order.orderNo}-`)))
    )
      throw new AppError("PROVIDER_UNAVAILABLE");
    if (
      await tx.paymentTxn.findFirst({
        where: { channel: "wechat_jsapi", channelTxnNo: fact.transactionId },
      })
    )
      throw new AppError("PROVIDER_UNAVAILABLE");
    const id = uuidv7(),
      now = deps.clock.now();
    // 已可信确认成功，直接补建成功尝试，不虚造closed、也不撞另一真实在途尝试的部分唯一约束。
    await tx.paymentTxn.createMany({
      data: [
        {
          id,
          entityId: recovery.order?.entityId ?? null,
          billingOrderId: recovery.order?.id ?? null,
          channel: "wechat_jsapi",
          outTradeNo: fact.outTradeNo,
          attemptNo: recovery.attemptNo,
          amountFen: recovery.order?.amountFen ?? fact.amountFen,
          payerOpenid: fact.payerOpenid,
          attach: recovery.order ? wechatOrderAttach(recovery.order) : (fact.attach ?? null),
          status: "succeeded",
          channelAmountFen: fact.amountFen,
          channelTxnNo: fact.transactionId,
          channelPayerRef: fact.payerOpenid,
          channelAttach: fact.attach ?? null,
          channelSuccessAt: fact.successAt,
          tradeStateRaw: fact.tradeState,
          bankType: fact.bankType ?? null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      skipDuplicates: true,
    });
    first = await tx.paymentTxn.findUniqueOrThrow({ where: { outTradeNo: fact.outTradeNo } });
    created = first.id === id;
  }
  if (!first) throw new AppError("NOT_FOUND");
  if (first.billingOrderId) await lockRows(tx, "billing_order", [first.billingOrderId]);
  await lockRows(tx, "payment_txn", [first.id]);
  const receipt = await tx.paymentTxn.findUniqueOrThrow({ where: { id: first.id } });
  if (receipt.billingOrderId !== first.billingOrderId || receipt.entityId !== first.entityId)
    throw new AppError("PRECONDITION_CHANGED");
  if (
    receipt.channel !== "wechat_jsapi" ||
    fact.tradeState !== "SUCCESS" ||
    fact.outTradeNo !== receipt.outTradeNo ||
    fact.appid !== deps.appid ||
    fact.mchid !== deps.mchid ||
    !fact.transactionId ||
    !Number.isSafeInteger(fact.amountFen) ||
    (fact.amountFen ?? 0) <= 0 ||
    !fact.payerOpenid ||
    !fact.successAt ||
    !Number.isFinite(fact.successAt.getTime()) ||
    fact.successAt > deps.clock.now()
  )
    throw new AppError("PROVIDER_UNAVAILABLE");
  // 同一渠道流水不能被另一个尝试接走；不把唯一约束异常当作已入账。
  if (
    await tx.paymentTxn.findFirst({
      where: { channel: "wechat_jsapi", channelTxnNo: fact.transactionId, id: { not: receipt.id } },
      select: { id: true },
    })
  )
    throw new AppError("PROVIDER_UNAVAILABLE");
  if (receipt.status === "succeeded" && !created) {
    if (
      receipt.channelTxnNo !== fact.transactionId ||
      receipt.channelAmountFen !== fact.amountFen ||
      receipt.channelPayerRef !== fact.payerOpenid ||
      receipt.channelAttach !== (fact.attach ?? null) ||
      receipt.channelSuccessAt?.getTime() !== fact.successAt.getTime()
    ) {
      if (!deps.exceptions) throw new AppError("PROVIDER_UNAVAILABLE");
      const order = first.billingOrderId
        ? await tx.billingOrder.findUniqueOrThrow({ where: { id: first.billingOrderId } })
        : null;
      await openPaymentException(tx, deps.exceptions, ctx, {
        kind: "status_mismatch",
        order,
        receipt,
        detectedBy: deps.detectedBy ?? "callback",
        channelFact: fact,
      });
      return { paymentTxnId: receipt.id, replayed: true, conflict: true };
    }
    return { paymentTxnId: receipt.id, replayed: true };
  }
  // closed 也可能收到可信迟到成功；资金事实保留，再由 applyPayment 判付后取消/差异。
  if (!created)
    await tx.paymentTxn.update({
      where: { id: receipt.id },
      data: {
        status: "succeeded",
        channelAmountFen: fact.amountFen,
        channelTxnNo: fact.transactionId,
        channelPayerRef: fact.payerOpenid,
        channelAttach: fact.attach ?? null,
        channelSuccessAt: fact.successAt,
        tradeStateRaw: fact.tradeState,
        bankType: fact.bankType ?? null,
        updatedAt: deps.clock.now(),
      },
    });
  await deps.events.emit(tx, ctx, {
    type: "payment_txn.succeeded",
    ...(first.entityId ? { entityId: first.entityId } : {}),
    aggregate: { type: "payment_txn", id: receipt.id },
    payload: {
      v: 1,
      paymentTxnId: receipt.id,
      billingOrderId: first.billingOrderId,
      amountFen: fact.amountFen!,
      channel: "wechat_jsapi",
    },
    dedupeKey: `payment_txn.succeeded:${receipt.id}`,
  });
  return { paymentTxnId: receipt.id, replayed: false };
}

/** D2§4.3：UUID为22字符base64url；保留固定v1/N/R/U/T格式。 */
export function wechatOrderAttach(order: BillingOrder): string | null {
  const parsed = billingOrderContentSchema.safeParse(order.contentSnapshot);
  if (!parsed.success) return null;
  const content = parsed.data;
  const code =
    order.type === "plan_new"
      ? "N"
      : order.type === "plan_renew"
        ? "R"
        : order.type === "plan_upgrade"
          ? "U"
          : order.type === "topup"
            ? "T"
            : null;
  if (
    !code ||
    (code === "N" || code === "R"
      ? content.kind !== "plan"
      : code === "U"
        ? content.kind !== "upgrade"
        : content.kind !== "topup")
  )
    return null;
  const id = (value: string) => Buffer.from(value.replaceAll("-", ""), "hex").toString("base64url");
  const refId =
    content.kind === "plan"
      ? content.planRevisionId
      : content.kind === "upgrade"
        ? content.toPlanRevisionId
        : content.packId;
  return `v1.${id(order.entityId)}.${id(order.id)}.${code}.${id(refId)}.${content.kind === "plan" ? content.months : 0}`;
}
export function wechatReceiptMatches(order: BillingOrder, receipt: PaymentTxn): boolean {
  return (
    receipt.channel !== "wechat_jsapi" ||
    (!!receipt.payerOpenid &&
      receipt.channelPayerRef === receipt.payerOpenid &&
      !!receipt.attach &&
      receipt.channelAttach === receipt.attach &&
      receipt.attach === wechatOrderAttach(order))
  );
}
