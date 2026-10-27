import type { WxBillFile, WxBillLine } from "@liyoxi/db";
import { calendarDate } from "@liyoxi/shared/time";
import { AppError, lockRows } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import type { WechatPayTransaction } from "../../providers/types.js";
import { recordChannelSuccess } from "../payment/channel-success.js";
import type { ReconciliationDeps } from "./context.js";
import { dayLock, ownTradeNo, sourceOf } from "./context.js";
import { healPlatformOnly, openDifference, refreshReceipt } from "./differences.js";

function agrees(deps: ReconciliationDeps, line: WxBillLine, fact: WechatPayTransaction) {
  const source = sourceOf(deps);
  return (
    fact.tradeState === "SUCCESS" &&
    fact.appid === source.appid &&
    fact.mchid === source.mchid &&
    fact.outTradeNo === line.outTradeNo &&
    fact.transactionId === line.transactionId &&
    fact.amountFen === line.orderAmountFen &&
    !!fact.payerOpenid &&
    !!fact.successAt &&
    Number.isFinite(fact.successAt.getTime()) &&
    fact.successAt <= deps.clock.now() &&
    calendarDate(fact.successAt) === line.billDate.toISOString().slice(0, 10)
  );
}
async function lockReceipt(tx: Tx, id: string) {
  const first = await tx.paymentTxn.findUniqueOrThrow({ where: { id } });
  if (first.billingOrderId) await lockRows(tx, "billing_order", [first.billingOrderId]);
  await lockRows(tx, "payment_txn", [id]);
  const current = await tx.paymentTxn.findUniqueOrThrow({ where: { id } });
  if (current.billingOrderId !== first.billingOrderId || current.entityId !== first.entityId)
    throw new AppError("PRECONDITION_CHANGED");
  return current;
}
/** 一行一个主体资金TX；查单在外，所有判据锁后复核。 */
export async function matchPayment(
  deps: ReconciliationDeps,
  ctx: IdentityContext,
  file: WxBillFile,
  line: WxBillLine,
  signal: AbortSignal,
) {
  const source = sourceOf(deps),
    day = file.billDate.toISOString().slice(0, 10);
  const first = await deps.tx.run((tx) =>
    tx.paymentTxn.findUnique({ where: { outTradeNo: line.outTradeNo } }),
  );
  let fact: WechatPayTransaction | undefined;
  if (!first || first.status !== "succeeded") {
    signal.throwIfAborted();
    const queried = await source.provider.queryByOutTradeNo({ outTradeNo: line.outTradeNo });
    signal.throwIfAborted();
    if (queried.ok) fact = queried.value;
  }
  return deps.tx.run(async (tx) => {
    await dayLock(tx, source.mchid, day);
    let receipt = await tx.paymentTxn.findUnique({ where: { outTradeNo: line.outTradeNo } });
    let recovered = false;
    if (receipt) receipt = await lockReceipt(tx, receipt.id);
    if ((!receipt || receipt.status !== "succeeded") && fact && agrees(deps, line, fact)) {
      const orderNo = ownTradeNo(deps, line.outTradeNo)!;
      const order = receipt
        ? null
        : await tx.billingOrder.findUnique({ where: { orderNo: orderNo[1]! } });
      const result = await recordChannelSuccess(
        tx,
        {
          clock: deps.clock,
          events: deps.events,
          appid: source.appid,
          mchid: source.mchid,
          exceptions: deps,
          detectedBy: "query",
        },
        ctx,
        receipt
          ? { paymentTxnId: receipt.id, transaction: fact }
          : { transaction: fact, recover: { order, attemptNo: Number(orderNo[2]) } },
      );
      recovered = !result.replayed;
      receipt = await tx.paymentTxn.findUniqueOrThrow({ where: { id: result.paymentTxnId } });
    }
    if (receipt) receipt = await lockReceipt(tx, receipt.id);
    const cashMatches =
      receipt?.channel === "wechat_jsapi" &&
      receipt.status === "succeeded" &&
      receipt.channelTxnNo === line.transactionId &&
      receipt.channelAmountFen === line.orderAmountFen &&
      !!receipt.channelSuccessAt &&
      calendarDate(receipt.channelSuccessAt) === day;
    if (!cashMatches) {
      const missing = !receipt,
        amountDiff =
          receipt?.status === "succeeded" && receipt.channelAmountFen !== line.orderAmountFen;
      await openDifference(tx, deps, ctx, {
        kind: missing ? "bill_only" : amountDiff ? "amount_mismatch" : "status_mismatch",
        day,
        key: `${missing ? "bill_only" : amountDiff ? "amount_mismatch" : "status_mismatch"}:${day}:${line.transactionId}`,
        amountFen: amountDiff
          ? Math.abs(line.orderAmountFen - (receipt?.channelAmountFen ?? 0))
          : line.orderAmountFen,
        receipt,
        line,
        cause: missing ? "账单收款尚无可信实时成功证明" : "账单与锁后收款事实不一致",
        billFact: {
          outTradeNo: line.outTradeNo,
          transactionId: line.transactionId,
          amountFen: line.orderAmountFen,
          state: line.tradeState,
        },
        platformFact: {
          amountFen: receipt?.channelAmountFen ?? null,
          state: receipt?.status ?? "missing",
        },
      });
      return tx.wxBillLine.update({
        where: { id: line.id },
        data: {
          matchState: missing ? "unmatched" : "diff",
          matchedPaymentTxnId: receipt?.id ?? null,
          updatedAt: deps.clock.now(),
        },
      });
    }
    // 上方事实判据证明非空，重新读取得到锁后实体，避免宽断言/缓存事实。
    const current = await tx.paymentTxn.findUniqueOrThrow({
      where: { outTradeNo: line.outTradeNo },
    });
    const exceptions = await tx.paymentException.findMany({
      where: { OR: [{ paymentTxnId: current.id }, { wxBillLineId: line.id }] },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    await lockRows(
      tx,
      "payment_exception",
      exceptions.map((e) => e.id),
    );
    if (
      recovered ||
      !current.billingOrderId ||
      (await tx.paymentException.count({
        where: { wxBillLineId: line.id, kind: "bill_only", status: "open" },
      }))
    ) {
      const id = await openDifference(tx, deps, ctx, {
        kind: "bill_only",
        day,
        key: `bill_only:${day}:${line.transactionId}`,
        amountFen: current.channelAmountFen!,
        receipt: current,
        line,
        cause: "对账发现并可信补记收款",
        billFact: {
          outTradeNo: line.outTradeNo,
          transactionId: line.transactionId,
          amountFen: line.orderAmountFen,
        },
      });
      await lockRows(tx, "payment_exception", [id]);
    }
    if (current.billingOrderId)
      await deps.payment.applyPayment(tx, { paymentTxnId: current.id, ctx });
    // 回调可能先完成入账；此时apply的已入账重放不再走其内部重分类，仍只关闭真实已关联bill_only。
    const applied = await tx.paymentTxn.findUniqueOrThrow({ where: { id: current.id } });
    if (applied.appliedAt && applied.billingOrderId) {
      const healed = await tx.paymentException.findMany({
        where: {
          paymentTxnId: applied.id,
          billingOrderId: applied.billingOrderId,
          kind: "bill_only",
          status: "open",
        },
        orderBy: { id: "asc" },
      });
      for (const row of healed)
        await deps.flow.transition(tx, ctx, {
          machine: "payment_exception",
          stateField: "status",
          id: row.id,
          event: "payment_exception.reclassify",
          ref: "08:767",
          args: { paymentTxnId: applied.id },
          set: { resolved_at: deps.clock.now() },
          ...(applied.entityId ? { entityId: applied.entityId } : {}),
          audit: {
            stream: "ops",
            category: "recon",
            action: "finance.reconciliation.healed",
            summary: "原收款已由可信回调入账",
            target: { type: "payment_exception", id: row.id },
          },
          emit: {
            type: "payment_exception.auto_healed",
            payload: { v: 1, paymentExceptionId: row.id },
            dedupeKey: `payment_exception.auto_healed:${row.id}`,
          },
        });
    }
    await tx.wxBillLine.update({
      where: { id: line.id },
      data: { matchState: "matched", matchedPaymentTxnId: current.id, updatedAt: deps.clock.now() },
    });
    await healPlatformOnly(tx, deps, ctx, current, line);
    const open = await refreshReceipt(tx, deps, current);
    await tx.paymentTxn.update({
      where: { id: current.id },
      data: {
        feeFen: line.feeFen,
        reconState: open ? "diff" : "matched",
        reconBillDate: file.billDate,
        updatedAt: deps.clock.now(),
      },
    });
  });
}
