import type { PaymentExceptionResolveBody } from "@liyoxi/contract";
import { assertPermission, byEntity } from "../../../authz/index.js";
import type { StaffContext } from "../../../authz/index.js";
import { AppError, createThreePhaseRunner, lockRows } from "../../../kernel/index.js";
import type { IdempotencyContext, IdentityContext, Tx } from "../../../kernel/index.js";
import type { WechatPayRefund, WechatPayTransaction } from "../../../providers/types.js";
import { assertStaff } from "../../refund/context.js";
import { submitExceptionRefund } from "../../refund/exception.js";
import { wechatReceiptMatches } from "../channel-success.js";
import { lockException, visible } from "./context.js";
import type { LockedException, PaymentExceptionDeps } from "./context.js";
import { recordExternalRefund } from "./external-refund.js";
import { pay, retry } from "./fulfill.js";
import { offlineReturn } from "./offline.js";
import { decodeAttach, rebuild } from "./rebuild.js";
import { detail } from "./read.js";
import { check, resolved } from "./state.js";

export type WriteOptions = { idem?: IdempotencyContext };
export function required(options: WriteOptions) {
  if (options.idem?.mode !== "required") throw new AppError("INTERNAL");
}
async function precheck(
  tx: Tx,
  deps: PaymentExceptionDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  input: PaymentExceptionResolveBody,
) {
  await assertStaff(tx, deps, ctx, staff, "finance.recon.resolve");
  const row = await visible(tx, staff, id);
  check(row, staff, input, deps.clock.now());
  return row;
}
async function link(
  tx: Tx,
  deps: PaymentExceptionDeps,
  staff: StaffContext,
  state: LockedException,
  input: PaymentExceptionResolveBody,
) {
  const { order, receipt, exception } = state;
  const reasons = [
    ...(!order || order.id !== input.linkPaymentOrderId ? ["order_missing"] : []),
    ...(order &&
    (order.channel !== "bank_transfer" ||
      !["pending_payment", "pending_confirmation"].includes(order.status) ||
      order.transferState === "confirm_review")
      ? ["order_not_pending_transfer"]
      : []),
    ...(!receipt ||
    receipt.channel !== "bank_transfer" ||
    receipt.status !== "succeeded" ||
    receipt.billingOrderId ||
    receipt.appliedAt ||
    receipt.refundedFen !== 0
      ? ["receipt_not_orphan"]
      : []),
    ...(order && receipt && receipt.channelAmountFen !== order.amountFen
      ? ["amount_mismatch"]
      : []),
    ...(order &&
    ((receipt?.entityId && receipt.entityId !== order.entityId) ||
      (exception.entityId && exception.entityId !== order.entityId))
      ? ["entity_mismatch"]
      : []),
  ];
  if (reasons.length || !order || !receipt)
    throw new AppError("LINK_ORDER_INVALID", { details: { reasons } });
  if (!(await tx.billingOrder.findFirst({ where: { id: order.id, ...byEntity(staff.scope) } })))
    throw new AppError("NOT_FOUND");
  const now = deps.clock.now();
  await tx.paymentTxn.update({
    where: { id: receipt.id },
    data: { billingOrderId: order.id, entityId: order.entityId, updatedAt: now },
  });
  await tx.paymentException.update({
    where: { id: exception.id },
    data: { billingOrderId: order.id, entityId: order.entityId, updatedAt: now },
  });
  return {
    ...state,
    receipt: { ...receipt, billingOrderId: order.id, entityId: order.entityId },
    exception: { ...exception, billingOrderId: order.id, entityId: order.entityId },
  };
}
type Observation =
  { type: "payment"; fact: WechatPayTransaction } | { type: "refund"; fact: WechatPayRefund };
export function createResolver(deps: PaymentExceptionDeps) {
  const phases = createThreePhaseRunner(deps);
  const configured = () => {
    if (!deps.wechatPay?.provider.configured) throw new AppError("PROVIDER_UNAVAILABLE");
    return deps.wechatPay;
  };
  async function finish(
    tx: Tx,
    ctx: IdentityContext,
    staff: StaffContext,
    id: string,
    input: PaymentExceptionResolveBody,
    observation?: Observation,
  ) {
    const first = await precheck(tx, deps, ctx, staff, id, input);
    if (input.resolution === "link_order") {
      const target = await tx.billingOrder.findFirst({
        where: { id: input.linkPaymentOrderId!, ...byEntity(staff.scope) },
      });
      if (!target)
        throw new AppError("LINK_ORDER_INVALID", { details: { reasons: ["order_missing"] } });
      await lockRows(tx, "entity", [target.entityId], "share");
    }
    if (
      input.resolution === "rebuild_order" &&
      observation?.type === "payment" &&
      observation.fact.attach
    ) {
      const target = decodeAttach(observation.fact.attach);
      await lockRows(tx, "entity", [target.entityId], "share");
      // 固定可信attach的原主键，先记录/尝试290锁，再锁300/340；缺行仍由rebuild复核并创建。
      // 后续真实fulfill对同一新行的290重入使用既有锁边界，不依赖flow的fresh map代替kernel锁序。
      await lockRows(tx, "billing_order", [target.orderId]);
    }
    let state = await lockException(
      tx,
      id,
      input.resolution === "link_order" ? input.linkPaymentOrderId : undefined,
    );
    check(state.exception, staff, input, deps.clock.now());
    if (state.exception.entityId !== first.entityId) throw new AppError("PRECONDITION_CHANGED");
    switch (input.resolution) {
      case "link_order":
        state = await link(tx, deps, staff, state, input);
        await pay(tx, deps, ctx, staff, state, input);
        break;
      case "retried":
        if ((await retry(tx, deps, ctx, state, input)).status === "blocked")
          return { ...(await detail(tx, deps, staff, id)), outcome: "still_blocked" as const };
        break;
      case "offline_return":
        await offlineReturn(tx, deps, staff, state, input);
        break;
      case "restore":
      case "rebuild_order": {
        if (observation?.type !== "payment" || !state.receipt) throw new AppError("INTERNAL");
        const fact = observation.fact,
          receipt = state.receipt;
        if (
          receipt.channel !== "wechat_jsapi" ||
          receipt.status !== "succeeded" ||
          fact.tradeState !== "SUCCESS" ||
          fact.outTradeNo !== receipt.outTradeNo ||
          fact.appid !== configured().appid ||
          fact.mchid !== configured().mchid ||
          !fact.transactionId ||
          fact.transactionId !== receipt.channelTxnNo ||
          !fact.amountFen ||
          fact.amountFen !== receipt.channelAmountFen ||
          !fact.successAt ||
          fact.successAt.getTime() !== receipt.channelSuccessAt?.getTime() ||
          fact.successAt > deps.clock.now() ||
          !fact.payerOpenid ||
          fact.payerOpenid !== receipt.channelPayerRef ||
          (fact.attach ?? null) !== receipt.channelAttach
        )
          throw new AppError("CHANNEL_RECHECK_FAILED", {
            details: { channelState: fact.tradeState, channelAmountFen: fact.amountFen ?? null },
          });
        if (input.resolution === "restore") {
          if (
            !state.order ||
            state.order.status !== "cancelled" ||
            !wechatReceiptMatches(state.order, receipt)
          )
            throw new AppError("CHANNEL_RECHECK_FAILED");
          await pay(tx, deps, ctx, staff, state, input);
        } else {
          const built = await rebuild(tx, deps, ctx, staff, state, fact, input);
          state = {
            ...state,
            order: built.order,
            exception: {
              ...state.exception,
              entityId: built.order.entityId,
              billingOrderId: built.order.id,
            },
          };
        }
        break;
      }
      case "record_channel_refund":
        if (observation?.type !== "refund") throw new AppError("INTERNAL");
        await recordExternalRefund(tx, deps, ctx, state, observation.fact);
        break;
      case "corrected":
      case "written_off":
        break; // 只记录runbook人工结论，绝不在处理器里虚构余额修复。
      default:
        throw new AppError("RESOLUTION_NOT_ALLOWED");
    }
    await resolved(tx, deps, ctx, staff, state.exception, input);
    return { ...(await detail(tx, deps, staff, id)), outcome: "resolved" as const };
  }
  return async (
    ctx: IdentityContext,
    staff: StaffContext,
    id: string,
    input: PaymentExceptionResolveBody,
    options: WriteOptions,
  ) => {
    required(options);
    if (input.resolution === "written_off")
      assertPermission(staff, "sys.super_admin", deps.clock.now());
    if (input.resolution === "refund")
      return deps.tx.run(async (tx) => {
        await precheck(tx, deps, ctx, staff, id, input);
        await submitExceptionRefund(
          tx,
          deps,
          ctx,
          staff,
          {
            paymentExceptionId: id,
            expectedVersion: input.lockVersion,
            note: input.note,
            confirm: input.confirm,
          },
          options.idem!.key,
        );
        return { ...(await detail(tx, deps, staff, id)), outcome: "refund_requested" as const };
      }, options);
    if (!["restore", "rebuild_order", "record_channel_refund"].includes(input.resolution))
      return deps.tx.run((tx) => finish(tx, ctx, staff, id, input), options);
    return phases.run(
      {
        claim: async (tx) => {
          await precheck(tx, deps, ctx, staff, id, input);
          const state = await lockException(tx, id);
          check(state.exception, staff, input, deps.clock.now());
          if (!state.receipt || state.receipt.channel !== "wechat_jsapi")
            throw new AppError("CHANNEL_RECHECK_FAILED");
          const line = state.exception.wxBillLineId
            ? await tx.wxBillLine.findUnique({ where: { id: state.exception.wxBillLineId } })
            : null;
          if (
            input.resolution === "record_channel_refund" &&
            (!line?.outRefundNo ||
              line.isForeign ||
              line.lineKind !== "refund" ||
              line.outTradeNo !== state.receipt.outTradeNo)
          )
            throw new AppError("CHANNEL_RECHECK_FAILED");
          return { outTradeNo: state.receipt.outTradeNo, outRefundNo: line?.outRefundNo ?? null };
        },
        external: async (intent): Promise<Observation> => {
          const provider = configured().provider;
          if (input.resolution === "record_channel_refund") {
            const result = await provider.queryRefund({ outRefundNo: intent.outRefundNo! });
            if (!result.ok) throw new AppError("PROVIDER_UNAVAILABLE");
            return { type: "refund", fact: result.value };
          }
          const result = await provider.queryByOutTradeNo({ outTradeNo: intent.outTradeNo });
          if (!result.ok) throw new AppError("PROVIDER_UNAVAILABLE");
          return { type: "payment", fact: result.value };
        },
        settle: (tx, observation) => finish(tx, ctx, staff, id, input, observation),
      },
      options,
    );
  };
}
