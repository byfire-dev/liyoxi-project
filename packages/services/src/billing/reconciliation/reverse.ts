import type { WxBillFile } from "@liyoxi/db";
import { addDays } from "@liyoxi/shared/time";
import { AppError, lockRows } from "../../kernel/index.js";
import type { IdentityContext } from "../../kernel/index.js";
import type { ReconciliationDeps } from "./context.js";
import { dayLock, sourceOf, windowOf } from "./context.js";
import { openDifference } from "./differences.js";

/** 只有完整、可信、已解析账单才允许推断缺行；missing/下载失败永不调用本函数。 */
export async function reverseMissing(
  deps: ReconciliationDeps,
  ctx: IdentityContext,
  file: WxBillFile,
  signal: AbortSignal,
) {
  const day = file.billDate.toISOString().slice(0, 10),
    source = sourceOf(deps);
  const receipts = await deps.tx.run((tx) =>
    tx.paymentTxn.findMany({
      where: {
        channel: "wechat_jsapi",
        status: "succeeded",
        channelSuccessAt: windowOf(day),
        wxBillLines: { none: { wxBillFileId: file.id, lineKind: "payment", isForeign: false } },
      },
      select: { id: true },
      orderBy: { id: "asc" },
    }),
  );
  for (const { id } of receipts) {
    signal.throwIfAborted();
    await deps.tx.run(async (tx) => {
      await dayLock(tx, source.mchid, day);
      const first = await tx.paymentTxn.findUniqueOrThrow({ where: { id } });
      if (first.billingOrderId) await lockRows(tx, "billing_order", [first.billingOrderId]);
      await lockRows(tx, "payment_txn", [id]);
      const receipt = await tx.paymentTxn.findUniqueOrThrow({ where: { id } });
      if (receipt.billingOrderId !== first.billingOrderId || receipt.entityId !== first.entityId)
        throw new AppError("PRECONDITION_CHANGED");
      // 按原单号/渠道号检查原件存在性，金额或状态不符由正向匹配分类，不重复开platform_only。
      if (
        await tx.wxBillLine.count({
          where: {
            wxBillFileId: file.id,
            lineKind: "payment",
            isForeign: false,
            outTradeNo: receipt.outTradeNo,
          },
        })
      )
        return;
      await openDifference(tx, deps, ctx, {
        kind: "platform_only",
        day,
        key: `platform_only:${day}:${receipt.outTradeNo}`,
        amountFen: receipt.channelAmountFen!,
        receipt,
        cause: "平台成功收款不在完整账单中",
        platformFact: {
          outTradeNo: receipt.outTradeNo,
          transactionId: receipt.channelTxnNo,
          amountFen: receipt.channelAmountFen,
          state: receipt.status,
        },
      });
    });
  }
  const waitDays = await deps.config.params.getAt("refund.bill_wait_days", deps.clock.now());
  const refunds = await deps.tx.run((tx) =>
    tx.refundTxn.findMany({
      where: {
        channel: "wechat_jsapi",
        status: "succeeded",
        successAt: { lt: windowOf(addDays(day, 1 - waitDays)).gte },
        wxBillLines: { none: { isForeign: false, wxBillFile: { status: "parsed" } } },
      },
      select: { id: true },
      orderBy: { id: "asc" },
    }),
  );
  for (const { id } of refunds) {
    signal.throwIfAborted();
    await deps.tx.run(async (tx) => {
      await dayLock(tx, source.mchid, day);
      const first = await tx.refundTxn.findUniqueOrThrow({ where: { id } });
      const receipt = await tx.paymentTxn.findUniqueOrThrow({ where: { id: first.paymentTxnId } });
      if (receipt.billingOrderId) await lockRows(tx, "billing_order", [receipt.billingOrderId]);
      await lockRows(tx, "payment_txn", [receipt.id]);
      await lockRows(tx, "refund_txn", [id]);
      const refund = await tx.refundTxn.findUniqueOrThrow({ where: { id } });
      const current = await tx.paymentTxn.findUniqueOrThrow({ where: { id: receipt.id } });
      if (
        current.billingOrderId !== receipt.billingOrderId ||
        current.entityId !== receipt.entityId ||
        refund.paymentTxnId !== receipt.id ||
        refund.billingOrderId !== current.billingOrderId ||
        refund.entityId !== current.entityId
      )
        throw new AppError("PRECONDITION_CHANGED");
      if (
        await tx.wxBillLine.count({
          where: {
            outRefundNo: refund.outRefundNo,
            isForeign: false,
            wxBillFile: { status: "parsed" },
          },
        })
      )
        return;
      await openDifference(tx, deps, ctx, {
        kind: "refund_platform_only",
        day,
        key: `refund_platform_only:${refund.outRefundNo}`,
        amountFen: refund.amountFen,
        receipt,
        refundTxnId: id,
        cause: "平台成功退款超过等待天数仍无退款账单行",
        platformFact: {
          outRefundNo: refund.outRefundNo,
          refundId: refund.channelRefundNo,
          amountFen: refund.amountFen,
          state: refund.status,
        },
      });
      await tx.refundTxn.update({
        where: { id },
        data: { reconState: "diff", updatedAt: deps.clock.now() },
      });
    });
  }
}
