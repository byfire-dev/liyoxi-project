import type { WxBillFile, WxBillLine } from "@liyoxi/db";
import { AppError, lockRows } from "../../kernel/index.js";
import type { IdentityContext } from "../../kernel/index.js";
import { recordRefundResult } from "../refund/index.js";
import type { ReconciliationDeps } from "./context.js";
import { dayLock, sourceOf } from "./context.js";
import { openDifference, refreshReceipt } from "./differences.js";
import { refundApplication } from "./refund-amount.js";

export async function matchRefund(
  deps: ReconciliationDeps,
  ctx: IdentityContext,
  file: WxBillFile,
  line: WxBillLine,
  signal: AbortSignal,
) {
  const source = sourceOf(deps),
    day = file.billDate.toISOString().slice(0, 10),
    amountFen = refundApplication(file, line);
  const first = await deps.tx.run((tx) =>
    tx.refundTxn.findUnique({ where: { outRefundNo: line.outRefundNo! } }),
  );
  // 账单记录的是受理日快照。非成功行只核对，绝不凭旧快照降低或提升现金状态。
  if (line.refundState === "SUCCESS" && first?.refundRequestId && first.status !== "succeeded") {
    signal.throwIfAborted();
    const result = await source.provider.queryRefund({ outRefundNo: first.outRefundNo });
    signal.throwIfAborted();
    if (
      result.ok &&
      result.value.outRefundNo === line.outRefundNo &&
      result.value.outTradeNo === line.outTradeNo &&
      result.value.refundId === line.refundId &&
      result.value.status === "SUCCESS"
    ) {
      // 公口自身先取260/280再取现金/账户锁，独立TX完成；不先拿本匹配TX的300/340。
      await deps.tx.run(async (tx) => {
        await dayLock(tx, source.mchid, day);
        await recordRefundResult(tx, deps, ctx, {
          refundTxnId: first.id,
          fact: result.value,
          detectedBy: "query",
        });
      });
    }
  }
  return deps.tx.run(async (tx) => {
    await dayLock(tx, source.mchid, day);
    const found = await tx.refundTxn.findUnique({ where: { outRefundNo: line.outRefundNo! } });
    let receipt = found
      ? await tx.paymentTxn.findUniqueOrThrow({ where: { id: found.paymentTxnId } })
      : await tx.paymentTxn.findUnique({ where: { outTradeNo: line.outTradeNo } });
    if (receipt?.billingOrderId) await lockRows(tx, "billing_order", [receipt.billingOrderId]);
    if (receipt) {
      const before = receipt;
      await lockRows(tx, "payment_txn", [receipt.id]);
      receipt = await tx.paymentTxn.findUniqueOrThrow({ where: { id: receipt.id } });
      if (receipt.billingOrderId !== before.billingOrderId || receipt.entityId !== before.entityId)
        throw new AppError("PRECONDITION_CHANGED");
    }
    if (found) await lockRows(tx, "refund_txn", [found.id]);
    const refund = found ? await tx.refundTxn.findUniqueOrThrow({ where: { id: found.id } }) : null;
    if (
      refund &&
      (refund.paymentTxnId !== found!.paymentTxnId ||
        refund.billingOrderId !== receipt?.billingOrderId ||
        refund.entityId !== receipt?.entityId)
    )
      throw new AppError("PRECONDITION_CHANGED");
    const moneyDiff = refund && refund.amountFen !== amountFen;
    const identity =
      refund?.channel === "wechat_jsapi" &&
      receipt?.outTradeNo === line.outTradeNo &&
      (!refund.channelRefundNo || refund.channelRefundNo === line.refundId);
    const terminal =
      line.refundState !== "SUCCESS" ||
      (refund?.status === "succeeded" && refund.channelRefundNo === line.refundId);
    if (!refund || moneyDiff || !identity || !terminal) {
      const kind = !refund
        ? "refund_bill_only"
        : moneyDiff
          ? "refund_amount_mismatch"
          : "status_mismatch";
      await openDifference(tx, deps, ctx, {
        kind,
        day,
        key: `${kind}:${day}:${line.outRefundNo}`,
        receipt,
        line,
        ...(refund ? { refundTxnId: refund.id } : {}),
        amountFen: moneyDiff ? Math.abs(amountFen - refund.amountFen) : amountFen,
        cause: !refund ? "账单退款没有本库交易，须财务核实补记" : "退款账单与锁后渠道事实不一致",
        billFact: {
          outRefundNo: line.outRefundNo,
          refundId: line.refundId,
          amountFen,
          state: line.refundState,
        },
        platformFact: { amountFen: refund?.amountFen ?? null, state: refund?.status ?? "missing" },
      });
      if (refund)
        await tx.refundTxn.update({
          where: { id: refund.id },
          data: { reconState: "diff", updatedAt: deps.clock.now() },
        });
      return tx.wxBillLine.update({
        where: { id: line.id },
        data: {
          matchState: refund ? "diff" : "unmatched",
          matchedRefundTxnId: refund?.id ?? null,
          matchedPaymentTxnId: receipt?.id ?? null,
          updatedAt: deps.clock.now(),
        },
      });
    }
    await tx.wxBillLine.update({
      where: { id: line.id },
      data: {
        matchState: line.refundState === "SUCCESS" ? "matched" : "matched_pending",
        matchedRefundTxnId: refund.id,
        matchedPaymentTxnId: receipt!.id,
        updatedAt: deps.clock.now(),
      },
    });
    if (line.refundState === "SUCCESS") {
      const open = await tx.paymentException.count({
        where: { refundTxnId: refund.id, status: { in: ["open", "resolving"] } },
      });
      await tx.refundTxn.update({
        where: { id: refund.id },
        data: {
          reconState: open ? "diff" : "matched",
          updatedAt: deps.clock.now(),
        },
      });
      await refreshReceipt(tx, deps, receipt!);
    }
  });
}
