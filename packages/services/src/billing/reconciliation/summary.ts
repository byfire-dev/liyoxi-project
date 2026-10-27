import type { WxBillFile } from "@liyoxi/db";
import { uuidv7 } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import type { ReconciliationDeps } from "./context.js";
import { dateValue, dayLock, sourceOf, windowOf } from "./context.js";
import { refundApplication } from "./refund-amount.js";

export async function cashTotals(tx: Tx, day: string) {
  const range = windowOf(day);
  const [r] = await tx.$queryRawUnsafe<
    { wc: number; wf: string; bc: number; bf: string; rc: number; rf: string }[]
  >(
    `
    SELECT count(*) FILTER(WHERE channel='wechat_jsapi')::int wc,
      COALESCE(sum(channel_amount_fen::bigint) FILTER(WHERE channel='wechat_jsapi'),0)::text wf,
      count(*) FILTER(WHERE channel='bank_transfer')::int bc,
      COALESCE(sum(channel_amount_fen::bigint) FILTER(WHERE channel='bank_transfer'),0)::text bf,
      (SELECT count(*)::int FROM refund_txn r JOIN payment_txn p ON p.id=r.payment_txn_id WHERE p.channel='wechat_jsapi' AND r.status='succeeded' AND r.success_at >= $1 AND r.success_at < $2) rc,
      (SELECT COALESCE(sum(r.amount_fen::bigint),0)::text FROM refund_txn r JOIN payment_txn p ON p.id=r.payment_txn_id WHERE p.channel='wechat_jsapi' AND r.status='succeeded' AND r.success_at >= $1 AND r.success_at < $2) rf
    FROM payment_txn WHERE status='succeeded' AND channel_success_at >= $1 AND channel_success_at < $2`,
    range.gte,
    range.lt,
  );
  return r!;
}
export async function finishDay(
  tx: Tx,
  deps: ReconciliationDeps,
  ctx: IdentityContext,
  day: string,
  file: WxBillFile | null,
  runKey?: string,
) {
  const source = deps.wechatPay;
  if (source) await dayLock(tx, source.mchid, day);
  const now = deps.clock.now(),
    billDate = dateValue(day),
    cash = await cashTotals(tx, day);
  const lines =
    file?.status === "parsed"
      ? await tx.wxBillLine.findMany({ where: { wxBillFileId: file.id, isForeign: false } })
      : [];
  const payment = lines.filter((l) => l.lineKind === "payment"),
    refunds = lines.filter((l) => l.lineKind === "refund");
  const payFen = payment.reduce((n, l) => n + BigInt(l.orderAmountFen), 0n);
  const refundFen = refunds.reduce((n, l) => n + BigInt(refundApplication(file!, l)), 0n);
  const [diff] = await tx.$queryRawUnsafe<{ n: number; fen: string; unresolved: number }[]>(
    `
    SELECT count(*) FILTER(WHERE status IN ('open','resolving','resolved'))::int n,
      COALESCE(sum(amount_fen::bigint) FILTER(WHERE status IN ('open','resolving','resolved')),0)::text fen,
      count(*) FILTER(WHERE status IN ('open','resolving'))::int unresolved
    FROM payment_exception WHERE bill_date=$1::date`,
    billDate,
  );
  const uncovered =
    file?.status === "parsed"
      ? await tx.wxBillLine.count({
          where: {
            wxBillFileId: file.id,
            isForeign: false,
            matchState: { notIn: ["matched", "matched_pending"] },
            paymentExceptions: { none: {} },
          },
        })
      : 0;
  const state =
    file?.status !== "parsed"
      ? "wait"
      : diff!.unresolved || uncovered
        ? "diff"
        : diff!.n
          ? "fixed"
          : cash.wc === payment.length && BigInt(cash.wf) === payFen
            ? "ok"
            : "diff";
  const prior = await tx.reconDay.findUnique({
    where: { billDate_channel: { billDate, channel: "wechat_jsapi" } },
  });
  const eventKey = prior && runKey ? `recon.day_closed:${prior.id}:${runKey}` : null;
  if (eventKey && (await tx.outboxEvent.findUnique({ where: { dedupeKey: eventKey } })))
    return prior!;
  await tx.reconDay.upsert({
    where: { billDate_channel: { billDate, channel: "bank_transfer" } },
    create: {
      id: uuidv7(),
      billDate,
      channel: "bank_transfer",
      bankCount: cash.bc,
      bankFen: BigInt(cash.bf),
      status: "ok",
      createdAt: now,
      updatedAt: now,
    },
    update: { bankCount: cash.bc, bankFen: BigInt(cash.bf), updatedAt: now },
  });
  const fields = {
    platformPayCount: cash.wc,
    platformPayFen: BigInt(cash.wf),
    billPayCount: payment.length,
    billPayFen: payFen,
    platformRefundCount: cash.rc,
    platformRefundFen: BigInt(cash.rf),
    billRefundCount: refunds.length,
    billRefundFen: refundFen,
    feeFen: lines.reduce((n, l) => n + BigInt(l.feeFen), 0n),
    diffCount: diff!.n,
    diffFen: BigInt(diff!.fen),
    status: state,
    updatedAt: now,
  };
  const row = await tx.reconDay.upsert({
    where: { billDate_channel: { billDate, channel: "wechat_jsapi" } },
    create: {
      id: uuidv7(),
      billDate,
      channel: "wechat_jsapi",
      ...fields,
      runCount: runKey ? 1 : 0,
      lastRunAt: runKey ? now : null,
      createdAt: now,
    },
    update: { ...fields, ...(runKey ? { runCount: { increment: 1 }, lastRunAt: now } : {}) },
  });
  if (runKey && file?.status === "parsed")
    await tx.wxBillFile.update({
      where: { id: file.id },
      data: { lastError: null, updatedAt: now },
    });
  if (runKey && file?.status === "parsed")
    await deps.events.emit(tx, ctx, {
      type: "recon.day_closed",
      aggregate: { type: "recon_day", id: row.id },
      payload: {
        v: 1,
        reconDayId: row.id,
        bizDate: day,
        status: state,
        diffCount: row.diffCount,
      },
      dedupeKey: `recon.day_closed:${row.id}:${runKey}`,
    });
  return row;
}
export async function parsedFile(tx: Tx, deps: ReconciliationDeps, day: string) {
  const source = sourceOf(deps);
  return tx.wxBillFile.findUnique({
    where: {
      mchid_billDate_billType: {
        mchid: source.mchid,
        billDate: dateValue(day),
        billType: "trade_all",
      },
    },
  });
}
