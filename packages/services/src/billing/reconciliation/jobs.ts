import { addDays, calendarDate } from "@liyoxi/shared/time";
import { AppError, uuidv7 } from "../../kernel/index.js";
import type { RecurringRunContext } from "../../kernel/index.js";
import { sendReceiptDailyDigest } from "../../notify/index.js";
import type { ReconciliationDeps } from "./context.js";
import { dateValue, system, underDay, windowOf } from "./context.js";
import { importDay } from "./import.js";
import { runParsed } from "./index.js";
import { cashTotals, finishDay, parsedFile } from "./summary.js";

function transport(ctx: RecurringRunContext) {
  if (!ctx.signal || !ctx.runTx) throw new TypeError("对账要求受租约保护的job运输");
  ctx.signal.throwIfAborted();
  return ctx.signal;
}
/** 独立于本期是否需要下载；no-op不能把14点仍缺账误清绿。 */
async function checkDeadline(deps: ReconciliationDeps, day: string, at: Date) {
  if (at < new Date(`${addDays(day, 1)}T14:00:00+08:00`)) return;
  const file = deps.wechatPay
    ? await deps.tx.run((tx) =>
        tx.wxBillFile.findUnique({
          where: {
            mchid_billDate_billType: {
              mchid: deps.wechatPay!.mchid,
              billDate: dateValue(day),
              billType: "trade_all",
            },
          },
        }),
      )
    : null;
  await deps.observeBillMissing(
    day,
    !!(file?.status === "parsed" && file.isHashVerified && file.fileId),
  );
}
export async function downloadBills(deps: ReconciliationDeps, ctx: RecurringRunContext) {
  const signal = transport(ctx),
    now = deps.clock.now(),
    today = calendarDate(now),
    yesterday = addDays(today, -1);
  await checkDeadline(deps, yesterday, now);
  const files = await deps.tx.run((tx) =>
    tx.wxBillFile.findMany({
      where: {
        ...(deps.wechatPay ? { mchid: deps.wechatPay.mchid } : {}),
        billType: "trade_all",
        billDate: { gte: dateValue(addDays(today, -90)), lt: dateValue(today) },
      },
    }),
  );
  // 旧日实际parsed证据继续采样，允许前日缺账告警恢复；不为旧missing日另开告警。
  for (const file of files) {
    const day = file.billDate.toISOString().slice(0, 10);
    if (day < yesterday && file.status === "parsed" && file.isHashVerified && file.fileId)
      await deps.observeBillMissing(day, true);
  }
  if (now < new Date(`${today}T10:30:00+08:00`)) return { skipped: "before_window" };
  const completed = await deps.tx.run((tx) =>
    tx.reconDay.findMany({
      where: {
        channel: "wechat_jsapi",
        billDate: { gte: dateValue(addDays(today, -90)), lt: dateValue(today) },
      },
    }),
  );
  let parsed = 0,
    waiting = 0,
    failed = 0;
  for (let day = yesterday; day >= addDays(today, -90); day = addDays(day, -1)) {
    signal.throwIfAborted();
    const old = files.find((f) => f.billDate.toISOString().slice(0, 10) === day);
    const recon = completed.find((r) => r.billDate.toISOString().slice(0, 10) === day);
    if (
      (old?.status === "parsed" && !old.lastError && recon?.lastRunAt && recon.status !== "wait") ||
      (old && now.getTime() - old.updatedAt.getTime() < 30 * 60_000)
    )
      continue;
    try {
      await underDay(
        deps,
        day,
        async (owned) => {
          const file = await importDay(deps, day, owned);
          if (file.status === "parsed") {
            await runParsed(deps, system(), file, owned);
            await deps.tx.run((tx) =>
              finishDay(tx, deps, system(), day, file, `job:${ctx.scheduledFor.toISOString()}`),
            );
            parsed++;
          } else {
            await deps.tx.run((tx) => finishDay(tx, deps, system(), day, file));
            waiting++;
          }
        },
        signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AppError && error.error === "BUSY") throw error;
      // 资金效果已独立提交的故障不伪装成功；保留真实已解析侧，下一期同原件/原号恢复。
      await ctx.runTx!(async (tx) => {
        const file = deps.wechatPay ? await parsedFile(tx, deps, day) : null;
        if (file?.status === "parsed")
          await tx.wxBillFile.update({
            where: { id: file.id },
            data: { lastError: "matching_failed", updatedAt: deps.clock.now() },
          });
        return finishDay(tx, deps, system(), day, file);
      });
      failed++;
    }
  }
  await checkDeadline(deps, yesterday, deps.clock.now());
  return { parsed, waiting, failed };
}
export async function receiptDigest(deps: ReconciliationDeps, ctx: RecurringRunContext) {
  const signal = transport(ctx),
    at = deps.clock.now(),
    day = calendarDate(ctx.scheduledFor);
  if (ctx.scheduledFor > at) throw new AppError("VALIDATION_FAILED");
  return ctx.runTx!(async (tx) => {
    signal.throwIfAborted();
    const receipts = await tx.paymentTxn.findMany({
      where: { channel: "bank_transfer", status: "succeeded", channelSuccessAt: windowOf(day) },
      include: {
        billingOrder: { select: { orderNo: true } },
        confirmedByStaff: { select: { id: true, name: true } },
      },
      orderBy: [{ channelSuccessAt: "asc" }, { id: "asc" }],
    });
    const serials = receipts.flatMap((r) => (r.channelTxnNo ? [r.channelTxnNo] : []));
    const peers = await tx.paymentTxn.findMany({
      where: { channel: "bank_transfer", channelTxnNo: { in: serials } },
      select: { id: true, createdAt: true, channelTxnNo: true },
    });
    const cash = await cashTotals(tx, day),
      billDate = dateValue(day);
    const bank = await tx.reconDay.upsert({
      where: { billDate_channel: { billDate, channel: "bank_transfer" } },
      create: {
        id: uuidv7(),
        billDate,
        channel: "bank_transfer",
        status: "ok",
        bankCount: cash.bc,
        bankFen: BigInt(cash.bf),
        createdAt: at,
        updatedAt: at,
      },
      update: { bankCount: cash.bc, bankFen: BigInt(cash.bf), updatedAt: at },
    });
    return sendReceiptDailyDigest(
      tx,
      {
        reconDayId: bank.id,
        bizDate: day,
        at,
        items: receipts.map((r) => {
          if (!r.channelSuccessAt || !r.channelAmountFen) throw new AppError("INTERNAL");
          return {
            paymentTxnId: r.id,
            orderNo: r.billingOrder?.orderNo ?? null,
            outTradeNo: r.outTradeNo,
            amountFen: r.channelAmountFen,
            confirmedAt: r.channelSuccessAt.toISOString(),
            confirmedBy: r.confirmedByStaff
              ? { staffId: r.confirmedByStaff.id, name: r.confirmedByStaff.name }
              : null,
            bankSerialConflictOverride:
              !!r.payerBank &&
              peers.some(
                (p) =>
                  p.id !== r.id &&
                  p.channelTxnNo === r.channelTxnNo &&
                  (p.createdAt < r.createdAt ||
                    (p.createdAt.getTime() === r.createdAt.getTime() && p.id < r.id)),
              ),
          };
        }),
      },
      deps.assembly,
    );
  });
}
