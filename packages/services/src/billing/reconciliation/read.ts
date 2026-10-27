import { ReconDayRowSchema, ReconMonthSchema } from "@liyoxi/contract";
import type { ReconDayRow, ReconMonth } from "@liyoxi/contract";
import type { ReconDay, WxBillFile } from "@liyoxi/db";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { hasPermission } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { assertFinanceView } from "../finance-config/read.js";
import { reconciliationExceptions } from "../payment/exceptions/read.js";
import type { ReconciliationDeps } from "./context.js";
import { dateValue } from "./context.js";

type Resolution = { day: string; resolution: string; fen: string; unresolved: number };
function rowView(
  staff: StaffContext,
  day: string,
  wx?: ReconDay,
  bank?: ReconDay,
  file?: WxBillFile,
  diff: Resolution[] = [],
): ReconDayRow {
  const parsed = file?.status === "parsed";
  return ReconDayRowSchema.parse({
    billDate: day,
    reconciliationId: wx?.id ?? null,
    platformPay: {
      count: wx?.platformPayCount ?? 0,
      amountFen: (wx?.platformPayFen ?? 0n).toString(),
    },
    billPay: parsed
      ? { count: wx?.billPayCount ?? 0, amountFen: (wx?.billPayFen ?? 0n).toString() }
      : null,
    bank: bank ? { count: bank.bankCount, amountFen: bank.bankFen.toString() } : null,
    refund: wx
      ? {
          platformCount: wx.platformRefundCount,
          platformFen: wx.platformRefundFen.toString(),
          billCount: wx.billRefundCount,
          billFen: wx.billRefundFen.toString(),
        }
      : null,
    feeFen: (wx?.feeFen ?? 0n).toString(),
    diff: wx?.diffCount
      ? {
          count: wx.diffCount,
          amountFen: wx.diffFen.toString(),
          resolutions: diff
            .filter((d) => d.resolution !== "none")
            .map((d) => ({ resolution: d.resolution, amountFen: d.fen })),
        }
      : null,
    status: wx?.status ?? "wait",
    billFileStatus: file?.status ?? null,
    runCount: wx?.runCount ?? 0,
    lastRunAt: wx?.lastRunAt?.toISOString() ?? null,
    actions: [
      ...(diff.some((d) => d.unresolved) ? ["resolve"] : []),
      ...(parsed && hasPermission(staff, "finance.recon.resolve") ? ["rerun"] : []),
    ],
  });
}
async function days(
  tx: Tx,
  deps: ReconciliationDeps,
  staff: StaffContext,
  from: string,
  to: string,
) {
  const range = { gte: dateValue(from), lt: dateValue(to) };
  const [rows, files, diffs] = await Promise.all([
    tx.reconDay.findMany({ where: { billDate: range } }),
    tx.wxBillFile.findMany({
      where: {
        billDate: range,
        ...(deps.wechatPay ? { mchid: deps.wechatPay.mchid } : {}),
        billType: "trade_all",
      },
    }),
    tx.$queryRawUnsafe<Resolution[]>(
      `SELECT bill_date::text AS "day", resolution, COALESCE(sum(amount_fen::bigint),0)::text fen,
      count(*) FILTER(WHERE status IN ('open','resolving'))::int unresolved
      FROM payment_exception WHERE bill_date >= $1::date AND bill_date < $2::date AND status IN ('open','resolving','resolved') GROUP BY bill_date,resolution`,
      range.gte,
      range.lt,
    ),
  ]);
  const result: ReconDayRow[] = [];
  for (let day = from; day < to; day = addDays(day, 1))
    result.push(
      rowView(
        staff,
        day,
        rows.find(
          (r) => r.channel === "wechat_jsapi" && r.billDate.toISOString().slice(0, 10) === day,
        ),
        rows.find(
          (r) => r.channel === "bank_transfer" && r.billDate.toISOString().slice(0, 10) === day,
        ),
        files.find((r) => r.billDate.toISOString().slice(0, 10) === day),
        diffs.filter((r) => r.day === day),
      ),
    );
  return result;
}
export async function dayView(tx: Tx, deps: ReconciliationDeps, staff: StaffContext, day: string) {
  return (await days(tx, deps, staff, day, addDays(day, 1)))[0]!;
}
export async function monthView(
  tx: Tx,
  deps: ReconciliationDeps,
  staff: StaffContext,
  month: string,
): Promise<ReconMonth> {
  assertFinanceView(staff);
  if (month > calendarDate(deps.clock.now()).slice(0, 7)) throw new AppError("VALIDATION_FAILED");
  const from = `${month}-01`,
    next = new Date(`${from}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const to = next.toISOString().slice(0, 10),
    items = (await days(tx, deps, staff, from, to)).reverse();
  const previous = new Date(`${from}T00:00:00Z`);
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  const prevFrom = previous.toISOString().slice(0, 10);
  const previousRows = await tx.reconDay.count({
    where: {
      channel: "wechat_jsapi",
      billDate: { gte: dateValue(prevFrom), lt: dateValue(from) },
      status: { in: ["ok", "fixed"] },
    },
  });
  const [refunds] = await tx.$queryRawUnsafe<{ n: number; fen: string; unmatched: number }[]>(
    `SELECT count(*)::int n, COALESCE(sum(amount_fen::bigint),0)::text fen,
    count(*) FILTER(WHERE recon_state NOT IN ('matched','resolved'))::int unmatched FROM refund_txn WHERE status='succeeded'
    AND (success_at AT TIME ZONE 'Asia/Shanghai')::date >= $1::date AND (success_at AT TIME ZONE 'Asia/Shanghai')::date < $2::date`,
    dateValue(from),
    dateValue(to),
  );
  const [diff] = await tx.$queryRawUnsafe<
    { n: number; fen: string; resolving: number; earliest: string | null }[]
  >(
    `SELECT count(*) FILTER(WHERE status='open')::int n,
    COALESCE(sum(amount_fen::bigint) FILTER(WHERE status='open'),0)::text fen, count(*) FILTER(WHERE status='resolving')::int resolving,
    min(bill_date) FILTER(WHERE status IN ('open','resolving'))::text earliest FROM payment_exception WHERE bill_date >= $1::date AND bill_date < $2::date`,
    dateValue(from),
    dateValue(to),
  );
  const sum = (fn: (r: ReconDayRow) => string) =>
    items.reduce((n, r) => n + BigInt(fn(r)), 0n).toString();
  const wc = items.reduce((n, r) => n + r.platformPay.count, 0),
    bc = items.reduce((n, r) => n + (r.bank?.count ?? 0), 0);
  return ReconMonthSchema.parse({
    items,
    month,
    overview: {
      platform: {
        count: wc + bc,
        wechatCount: wc,
        bankCount: bc,
        amountFen: (
          BigInt(sum((r) => r.platformPay.amountFen)) + BigInt(sum((r) => r.bank?.amountFen ?? "0"))
        ).toString(),
      },
      wechatBill: {
        count: items.reduce((n, r) => n + (r.billPay?.count ?? 0), 0),
        amountFen: sum((r) => r.billPay?.amountFen ?? "0"),
        downloadedThrough:
          items.find((r) => r.billFileStatus === "parsed" || r.billFileStatus === "empty")
            ?.billDate ?? null,
      },
      refund: {
        count: refunds!.n,
        amountFen: refunds!.fen,
        isBillMatched: refunds!.unmatched === 0,
      },
      diff: {
        openCount: diff!.n,
        openAmountFen: diff!.fen,
        resolvingCount: diff!.resolving,
        earliestOpenBillDate: diff!.earliest,
      },
    },
    dayStatusCounts: Object.fromEntries(
      ["ok", "diff", "fixed", "wait"].map((s) => [s, items.filter((r) => r.status === s).length]),
    ),
    openExceptions: await reconciliationExceptions(tx, deps, staff, dateValue(from), dateValue(to)),
    prevMonthAllOk:
      previousRows === (dateValue(from).getTime() - dateValue(prevFrom).getTime()) / 86_400_000,
  });
}
