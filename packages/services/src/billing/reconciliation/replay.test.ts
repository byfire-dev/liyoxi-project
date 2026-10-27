import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { calendarDate } from "@liyoxi/shared/time";
import { uuidv7 } from "../../kernel/index.js";
import { recordChannelSuccess } from "../payment/channel-success.js";
import { fulfillOpKey, createPaymentExceptions, wechatOrderAttach } from "../index.js";
import { PaymentExceptionResolveBodySchema } from "@liyoxi/contract";

import type { ReconciliationHarness } from "../../testing/index.js";

import {
  createReconciliationHarness,
  sourceBill,
  refundIdempotencyForTest as refundIdem,
  pendingPlanOrder,
  pendingWechatReceipt,
  snapshotTables,
  useSeededDatabase,
} from "../../testing/index.js";

import { dateValue, system, underDay } from "./context.js";
import { importDay } from "./import.js";
import { finishDay, cashTotals } from "./summary.js";
import { downloadBills } from "./jobs.js";
import { reconciliationInvariants } from "./invariants.js";

function barrier() {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const db = useSeededDatabase("services", { max: 3, label: "recon" });
let h: ReconciliationHarness;
beforeEach(async () => {
  await db.reset();
  h = createReconciliationHarness(await db.prisma(), await db.url());
}, 60_000);
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.close();
});
const financial = [
  "payment_txn",
  "billing_order",
  "refund_txn",
  "refund_request",
  "point_ledger_entry",
  "ledger_operation",
  "subscription_term",
  "approval_request",
];
async function pending() {
  const own = await h.make.merchant({ verified: true });
  const order = await pendingPlanOrder(h, { entityId: own.entity.id, channel: "wechat_jsapi" }),
    receipt = await pendingWechatReceipt(h, order);
  const made = await h.provider.wechatPay.createJsapiOrder({
    outTradeNo: receipt.outTradeNo,
    description: "隔离账单可信收款",
    amountFen: receipt.amountFen,
    payerOpenid: receipt.payerOpenid!,
    attach: receipt.attach!,
    expireAt: order.expiresAt,
  });
  if (!made.ok) throw new Error("测试预下单失败");
  const paid = h.provider.wechatPay.pay(receipt.outTradeNo);
  if (paid.kind !== "transaction") throw new Error("测试渠道事实类型错误");
  return { ...own, order, receipt, fact: paid.transaction };
}
async function original(day: string, text: string) {
  h.provider.wechatPay.setTradeBill(day, text);
  return underDay(h.deps, day, (signal) => importDay(h.deps, day, signal));
}
async function rerun(day: string, key = uuidv7()) {
  const file = await h.prisma.wxBillFile.findFirstOrThrow({
    where: { billDate: dateValue(day), mchid: h.deps.wechatPay!.mchid },
  });
  const row = await h.tx.run((tx) => finishDay(tx, h.deps, system(), day, file));
  const actor = await h.staff(),
    body = { confirm: { billDate: day } };
  const options = refundIdem(actor.ctx, "admin.reconciliation.rerun", body, key);
  return {
    result: await h.reconciliation.rerun(actor.ctx, actor.staff, row.id, body, options),
    actor,
    body,
    options,
    row,
    key,
  };
}
async function zero() {
  for (const rule of reconciliationInvariants)
    expect(await h.tx.run((tx) => rule.run!(tx, {}, { now: h.clock.now() })), rule.code).toEqual(
      [],
    );
}
it("可信missing/坏摘要/错误来源/错日/坏汇总都零资金；missing保留pending而非empty或ok", async () => {
  const day = calendarDate(h.clock.now());
  h.clock.advance(86_400_000);
  const before = await snapshotTables(h.prisma, financial);
  const missing = await underDay(h.deps, day, (signal) => importDay(h.deps, day, signal));
  expect(missing).toMatchObject({
    status: "pending",
    lastError: "NO_STATEMENT_EXIST",
    fileId: null,
    sha1: null,
    isHashVerified: false,
  });
  await h.tx.run((tx) => finishDay(tx, h.deps, system(), day, missing));
  expect(await h.prisma.reconDay.findFirst({ where: { channel: "wechat_jsapi" } })).toMatchObject({
    status: "wait",
    runCount: 0,
  });
  const fetch = vi.spyOn(h.provider.wechatPay, "fetchVerifiedTradeBill");
  fetch.mockImplementationOnce(async () => ({
    ok: true,
    value: h.invalidDigest(day, new TextEncoder().encode(sourceBill(day, []))),
  }));
  await expect(underDay(h.deps, day, (signal) => importDay(h.deps, day, signal))).rejects.toThrow(
    "摘要",
  );
  h.provider.wechatPay.useWireFormat({ appid: "wx-other", mchid: "1900000109" });
  await expect(original(day, sourceBill(day, []))).rejects.toMatchObject({ code: "source" });
  h.provider.wechatPay.useWireFormat({
    appid: h.deps.wechatPay!.appid,
    mchid: h.deps.wechatPay!.mchid,
  });
  await expect(
    original(
      day,
      sourceBill("2026-01-04", [
        { outTradeNo: "FK2026010599999-01-ABC123", transactionId: "wx-test" },
      ]),
    ),
  ).rejects.toMatchObject({ code: "trade_date" });
  await expect(
    original(
      day,
      sourceBill(day, [
        { outTradeNo: "FK2026010599999-01-ABC123", transactionId: "wx-test" },
      ]).replace("`1,`1.00", "`2,`1.00"),
    ),
  ).rejects.toMatchObject({ code: "summary_count" });
  expect(await snapshotTables(h.prisma, financial)).toEqual(before);
  expect(await h.prisma.wxBillLine.count()).toBe(0);
  expect(await h.prisma.fileObject.count({ where: { category: "pay_bill" } })).toBe(0);
});
it("真实收款/foreign/平台缺行按独立金额模型分类；原件永久留证且required同键冻结不多账", async () => {
  const a = await h.paid(),
    b = await h.paid(),
    day = calendarDate(h.clock.now());
  h.clock.advance(86_400_000);
  const file = await original(
    day,
    sourceBill(day, [
      {
        outTradeNo: a.receipt.outTradeNo,
        transactionId: a.receipt.channelTxnNo!,
        amountFen: a.receipt.channelAmountFen!,
        feeFen: 60,
      },
      { outTradeNo: "OTHER-01-ABC123", transactionId: "foreign-order", amountFen: 123 },
    ]),
  );
  const stable = financial.filter((table) => table !== "payment_txn" && table !== "billing_order");
  const before = await snapshotTables(h.prisma, stable),
    queries = h.provider.wechatPay.callsOf("queryByOutTradeNo").length;
  const run = await rerun(day);
  expect(run.result).toMatchObject({
    platformPay: {
      count: 2,
      amountFen: String(a.receipt.channelAmountFen! + b.receipt.channelAmountFen!),
    },
    billPay: { count: 1, amountFen: String(a.receipt.channelAmountFen) },
    status: "diff",
    runCount: 1,
    feeFen: "60",
    diff: { count: 1, amountFen: String(b.receipt.channelAmountFen) },
  });
  expect(
    await h.reconciliation.rerun(
      run.actor.ctx,
      run.actor.staff,
      run.row.id,
      run.body,
      refundIdem(run.actor.ctx, "admin.reconciliation.rerun", run.body, run.key),
    ),
  ).toEqual(run.result);
  expect(await snapshotTables(h.prisma, stable)).toEqual(before);
  expect(h.provider.wechatPay.callsOf("queryByOutTradeNo")).toHaveLength(queries);
  expect(await h.prisma.paymentException.findMany()).toMatchObject([
    { kind: "platform_only", paymentTxnId: b.receipt.id, status: "open" },
  ]);
  expect(await h.prisma.wxBillLine.findMany({ orderBy: { lineNo: "asc" } })).toMatchObject([
    { matchState: "matched" },
    { matchState: "foreign", isForeign: true },
  ]);
  const ref = await h.prisma.fileRef.findFirstOrThrow({
    where: { refType: "wx_bill_file", refId: file.id },
  });
  expect(await h.prisma.fileObject.findUniqueOrThrow({ where: { id: ref.fileId } })).toMatchObject({
    category: "pay_bill",
    bucket: "secure",
    status: "stored",
  });
  await zero();
});
it("callback在真实290锁屏障先提交后，账单锁后不虚造bill_only且资金/现金事件均不重放", async () => {
  const a = await pending(),
    day = calendarDate(h.clock.now());
  h.clock.advance(86_400_000);
  await original(
    day,
    sourceBill(day, [
      {
        outTradeNo: a.receipt.outTradeNo,
        transactionId: a.fact.transactionId!,
        amountFen: a.receipt.amountFen,
      },
    ]),
  );
  const entered = barrier(),
    release = barrier();
  const callback = h.tx.run(async (tx) => {
    await recordChannelSuccess(
      tx,
      {
        clock: h.clock,
        events: h.deps.events,
        appid: h.deps.wechatPay!.appid,
        mchid: h.deps.wechatPay!.mchid,
      },
      system(),
      { paymentTxnId: a.receipt.id, transaction: a.fact },
    );
    await h.deps.payment.applyPayment(tx, { paymentTxnId: a.receipt.id });
    entered.resolve();
    await release.promise;
  });
  void callback.catch(entered.reject);
  await entered.promise;
  const running = rerun(day);
  void running.catch(() => undefined);
  try {
    await Promise.race([
      running.then(() => {
        throw new Error("对账未等真实收款锁即结束");
      }),
      vi.waitFor(
        async () => {
          const [v] = await h.prisma.$queryRawUnsafe<{ n: number }[]>(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0",
          );
          expect(v!.n).toBeGreaterThan(0);
        },
        { timeout: 3000, interval: 10 },
      ),
    ]);
  } finally {
    release.resolve();
    await Promise.allSettled([callback, running]);
  }
  await callback;
  const result = await running;
  expect(result.result).toMatchObject({ status: "ok", diff: null, runCount: 1 });
  expect(await h.prisma.paymentException.count()).toBe(0);
  expect(await h.prisma.ledgerOperation.count({ where: { opKey: fulfillOpKey(a.order.id) } })).toBe(
    1,
  );
  expect(
    await h.prisma.outboxEvent.count({
      where: { eventType: "payment_txn.succeeded", aggregateId: a.receipt.id },
    }),
  ).toBe(1);
  expect(
    await h.prisma.paymentTxn.findUniqueOrThrow({ where: { id: a.receipt.id } }),
  ).toMatchObject({ status: "succeeded", channelAmountFen: a.receipt.amountFen });
  await zero();
});

async function orphan() {
  const own = await h.make.merchant({ verified: true });
  const template = await pendingPlanOrder(h, { entityId: own.entity.id, channel: "wechat_jsapi" });
  const order = {
    ...template,
    id: uuidv7(),
    orderNo: await h.tx.run((tx) => h.deps.bizNo.next(tx, "FK")),
  };
  const outTradeNo = `${order.orderNo}-01-A1B2C3`;
  const made = await h.provider.wechatPay.createJsapiOrder({
    outTradeNo,
    description: "真实孤儿渠道证明",
    amountFen: order.amountFen,
    payerOpenid: `o_test_${own.entity.id}`,
    attach: wechatOrderAttach(order)!,
    expireAt: order.expiresAt,
  });
  if (!made.ok) throw new Error("预下单失败");
  const notice = h.provider.wechatPay.pay(outTradeNo);
  if (notice.kind !== "transaction") throw new Error("非收款事实");
  return { ...own, order, fact: notice.transaction };
}
async function recordOrphan(value: Awaited<ReturnType<typeof orphan>>) {
  return h.tx.run(async (tx) => {
    const result = await recordChannelSuccess(
      tx,
      {
        clock: h.clock,
        events: h.deps.events,
        appid: h.deps.wechatPay!.appid,
        mchid: h.deps.wechatPay!.mchid,
        exceptions: h.deps,
      },
      system(),
      { transaction: value.fact, recover: { order: null, attemptNo: 1 } },
    );
    await h.payment.applyPayment(tx, { paymentTxnId: result.paymentTxnId });
    return tx.paymentTxn.findUniqueOrThrow({ where: { id: result.paymentTxnId } });
  });
}
async function exceptionResolve(
  actor: Awaited<ReturnType<typeof h.staff>>,
  id: string,
  resolution: "rebuild_order" | "offline_return",
  extra = {},
  fulfillment = h.fulfillment,
) {
  const service = createPaymentExceptions({ ...h.deps, fulfillment });
  const row = await h.prisma.paymentException.findUniqueOrThrow({ where: { id } });
  const body = PaymentExceptionResolveBodySchema.parse({
    lockVersion: row.lockVersion,
    resolution,
    note: "已核对对账真实资金事实",
    confirm: { exceptionNo: row.exceptionNo, amountFen: row.amountFen },
    ...extra,
  });
  return service.resolve(
    actor.ctx,
    actor.staff,
    id,
    body,
    refundIdem(actor.ctx, "admin.paymentException.resolve", body),
  );
}
it("孤儿apply先到/账单先到均复用同一物理差异；W411真实重建并发受控重试而不倒序锁", async () => {
  const a = await orphan(),
    b = await orphan(),
    day = calendarDate(h.clock.now());
  const receiptA = await recordOrphan(a);
  const prior = await h.prisma.paymentException.findFirstOrThrow({
    where: { paymentTxnId: receiptA.id },
  });
  h.clock.advance(86_400_000);
  await original(
    day,
    sourceBill(
      day,
      [a, b].map((v) => ({
        outTradeNo: v.fact.outTradeNo,
        transactionId: v.fact.transactionId!,
        amountFen: v.fact.amountFen!,
      })),
    ),
  );
  h.provider.wechatPay.failNext("queryByOutTradeNo");
  await rerun(day);
  const before = await h.prisma.paymentException.findMany({
    where: { kind: "bill_only" },
    orderBy: { createdAt: "asc" },
  });
  expect(before).toHaveLength(2);
  expect(before.find((e) => e.id === prior.id)).toMatchObject({
    paymentTxnId: receiptA.id,
    wxBillLineId: expect.any(String),
  });
  const receiptB = await recordOrphan(b);
  const bound = await h.prisma.paymentException.findFirstOrThrow({
    where: { paymentTxnId: receiptB.id },
  });
  expect(bound.id).toBe(before.find((e) => e.id !== prior.id)!.id);
  await rerun(day);
  expect(await h.prisma.paymentException.count({ where: { kind: "bill_only" } })).toBe(2);
  const actor = await h.staff("super_admin"),
    entered = barrier(),
    release = barrier();
  const rebuilding = exceptionResolve(
    actor,
    prior.id,
    "rebuild_order",
    {},
    {
      fulfill: async (tx, input) => {
        const result = await h.fulfillment.fulfill(tx, input);
        entered.resolve();
        await release.promise;
        return result;
      },
    },
  );
  void rebuilding.catch(entered.reject);
  await entered.promise;
  const racing = rerun(day);
  void racing.catch(() => undefined);
  try {
    await Promise.race([
      racing.then(() => {
        throw new Error("未等重建事务即结束");
      }),
      vi.waitFor(
        async () => {
          const [row] = await h.prisma.$queryRawUnsafe<{ n: number }[]>(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0",
          );
          expect(row!.n).toBeGreaterThan(0);
        },
        { timeout: 3000, interval: 10 },
      ),
    ]);
  } finally {
    release.resolve();
    await Promise.allSettled([rebuilding, racing]);
  }
  await rebuilding;
  await expect(racing).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
  await rerun(day);
  expect(
    await h.prisma.paymentException.findUniqueOrThrow({ where: { id: prior.id } }),
  ).toMatchObject({ status: "resolved", resolution: "rebuild_order", billingOrderId: a.order.id });
  expect(await h.prisma.paymentException.count({ where: { kind: "bill_only" } })).toBe(2);
  expect(await h.prisma.ledgerOperation.count({ where: { opKey: fulfillOpKey(a.order.id) } })).toBe(
    1,
  );
  await zero();
});
it("含券退款按申请额经真实query补记；PROCESSING仅matched_pending且同原件重放不再退款", async () => {
  const done = await h.approved(),
    pending = await h.approved(),
    day = calendarDate(h.clock.now());
  await h.execute(done);
  await h.execute(pending);
  const a = await h.prisma.refundTxn.findFirstOrThrow({
    where: { refundRequestId: done.created.refundRequestId },
  });
  const b = await h.prisma.refundTxn.findFirstOrThrow({
    where: { refundRequestId: pending.created.refundRequestId },
  });
  const notice = h.provider.wechatPay.completeRefund(a.outRefundNo, { status: "SUCCESS" });
  if (notice.kind !== "refund") throw new Error("非退款事实");
  const proof = await h.provider.wechatPay.queryRefund({ outRefundNo: b.outRefundNo });
  if (!proof.ok) throw new Error("测试实时查询失败");
  h.clock.advance(86_400_000);
  await original(
    day,
    sourceBill(day, [
      ...[done, pending].map((v) => ({
        outTradeNo: v.receipt.outTradeNo,
        transactionId: v.receipt.channelTxnNo!,
        amountFen: v.receipt.channelAmountFen!,
      })),
      {
        outTradeNo: done.receipt.outTradeNo,
        transactionId: done.receipt.channelTxnNo!,
        refund: {
          outRefundNo: a.outRefundNo,
          refundId: notice.refund.refundId!,
          applicationFen: a.amountFen,
          settlementFen: a.amountFen - 200,
          couponFen: 200,
        },
      },
      {
        outTradeNo: pending.receipt.outTradeNo,
        transactionId: pending.receipt.channelTxnNo!,
        refund: {
          outRefundNo: b.outRefundNo,
          refundId: proof.value.refundId!,
          applicationFen: b.amountFen,
          state: "PROCESSING",
        },
      },
    ]),
  );
  const queries = h.provider.wechatPay.callsOf("queryRefund").length;
  const result = await rerun(day);
  expect(result.result.refund).toEqual({
    platformCount: 1,
    platformFen: String(a.amountFen),
    billCount: 2,
    billFen: String(a.amountFen + b.amountFen),
  });
  expect(await h.prisma.refundTxn.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
    status: "succeeded",
    amountFen: a.amountFen,
  });
  expect(await h.prisma.refundTxn.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({
    status: "processing",
  });
  expect(
    await h.prisma.wxBillLine.findMany({
      where: { lineKind: "refund" },
      orderBy: { lineNo: "asc" },
    }),
  ).toMatchObject([
    { matchState: "matched", refundAmountFen: a.amountFen - 200 },
    { matchState: "matched_pending" },
  ]);
  expect(h.provider.wechatPay.callsOf("queryRefund")).toHaveLength(queries + 1);
  const cash = await snapshotTables(
    h.prisma,
    financial.filter((v) => v !== "payment_txn" && v !== "billing_order"),
  );
  await rerun(day);
  expect(
    await snapshotTables(
      h.prisma,
      financial.filter((v) => v !== "payment_txn" && v !== "billing_order"),
    ),
  ).toEqual(cash);
  expect(h.provider.wechatPay.callsOf("queryRefund")).toHaveLength(queries + 1);
  await zero();
});
it("同日线下退款按原收款渠道归属：微信人工退款计微信，对公退回不混入", async () => {
  const wx = await h.approved(),
    day = calendarDate(h.clock.now());
  const file = await h.make.fileObject({
    category: "pay_receipt",
    scopeType: "entity",
    entityId: wx.entity.id,
    uploadActorType: "staff",
    uploadActorId: wx.executor.row.id,
    uploadClient: "admin",
    status: "stored",
    moderationState: "pass",
  });
  const body = {
    confirm: { requestNo: wx.created.requestNo, amountFen: wx.created.amountFen },
    confirmChecks: ["offline_transfer_checked"],
    transferDate: day,
    bankSerialNo: "WX-OFFLINE-1",
    payeeName: wx.entity.name!,
    payeeBank: "公开测试银行",
    payeeAccount: "6222000000000000",
    receiptFileId: file.id,
    note: "原微信付款已核准人工转账",
  };
  await h.service.recordOffline(
    wx.executor.ctx,
    wx.executor.staff,
    wx.created.refundRequestId,
    body,
    refundIdem(wx.executor.ctx, "admin.refundRequest.recordOffline", body),
  );
  const actor = await h.staff("super_admin"),
    service = createPaymentExceptions({ ...h.deps, fulfillment: h.fulfillment });
  const input = {
    receivedAt: h.clock.now().toISOString(),
    amountFen: 32100,
    payerName: "公开对公付款人",
    bankSerialNo: "BANK-IN-1",
    note: "真实未匹配银行收款",
    confirm: { amountFen: 32100, bankSerialNo: "BANK-IN-1" },
  };
  const bank = await service.create(
    actor.ctx,
    actor.staff,
    input,
    refundIdem(actor.ctx, "admin.paymentException.create", input),
  );
  const bankFile = await h.make.fileObject({
    category: "pay_receipt",
    scopeType: "platform",
    entityId: null,
    uploadActorType: "staff",
    uploadActorId: actor.row.id,
    uploadClient: "admin",
    status: "stored",
    moderationState: "pass",
  });
  await exceptionResolve(actor, bank.paymentExceptionId, "offline_return", {
    offlineReturn: {
      transferDate: day,
      bankSerialNo: "BANK-OUT-1",
      payeeName: input.payerName,
      payeeBank: "公开测试银行",
      payeeAccount: "6222000000000000",
      receiptFileId: bankFile.id,
    },
  });
  const totals = await h.tx.run((tx) => cashTotals(tx, day));
  expect(totals).toMatchObject({
    wc: 1,
    wf: String(wx.receipt.channelAmountFen),
    bc: 1,
    bf: "32100",
    rc: 1,
    rf: String(wx.created.amountFen),
  });
  expect(
    await h.prisma.refundTxn.count({ where: { channel: "offline", status: "succeeded" } }),
  ).toBe(2);
});
it("已完成diff后中断持久matching_failed；29分钟不重试/30分钟同原件恢复且资金不重放", async () => {
  const a = await pending(),
    day = calendarDate(h.clock.now());
  h.clock.advance(86_400_000);
  const file = await original(
    day,
    sourceBill(day, [
      {
        outTradeNo: a.receipt.outTradeNo,
        transactionId: a.fact.transactionId!,
        amountFen: a.receipt.amountFen,
      },
    ]),
  );
  h.provider.wechatPay.failNext("queryByOutTradeNo");
  const prior = await rerun(day);
  expect(prior.result).toMatchObject({ status: "diff", runCount: 1 });
  const query = vi
    .spyOn(h.provider.wechatPay, "queryByOutTradeNo")
    .mockRejectedValueOnce(new Error("isolated matcher transport"));
  await expect(rerun(day)).rejects.toThrow("isolated matcher transport");
  expect(await h.prisma.wxBillFile.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({
    status: "parsed",
    sha1: file.sha1,
    fileId: file.fileId,
    lastError: "matching_failed",
  });
  const run = () =>
    downloadBills(h.deps, {
      signal: new AbortController().signal,
      scheduledFor: h.clock.now(),
      runTx: (fn) => h.tx.run(fn),
    });
  const count = () =>
    query.mock.calls.filter(([v]) => v.outTradeNo === a.receipt.outTradeNo).length;
  const failedCount = count();
  h.clock.advance(29 * 60_000);
  await run();
  expect(count()).toBe(failedCount);
  h.clock.advance(60_000);
  await run();
  expect(count()).toBe(failedCount + 1);
  expect(await h.prisma.wxBillFile.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({
    status: "parsed",
    sha1: file.sha1,
    fileId: file.fileId,
    lastError: null,
  });
  expect(await h.prisma.reconDay.findUniqueOrThrow({ where: { id: prior.row.id } })).toMatchObject({
    runCount: 2,
    lastRunAt: h.clock.now(),
  });
  expect(await h.prisma.ledgerOperation.count({ where: { opKey: fulfillOpKey(a.order.id) } })).toBe(
    1,
  );
  h.clock.advance(30 * 60_000);
  await run();
  expect(count()).toBe(failedCount + 1);
  await zero();
}, 60_000);
it("14点缺账P2不因no-op清绿；真实原件三次采样恢复，I7/I8从持久事实抓反例", async () => {
  const day = "2026-01-05",
    run = () =>
      downloadBills(h.deps, {
        signal: new AbortController().signal,
        scheduledFor: h.clock.now(),
        runTx: (fn) => h.tx.run(fn),
      });
  h.clock.set(new Date("2026-01-06T13:59:00+08:00"));
  await run();
  expect(await h.prisma.alertEvent.count({ where: { rule: "billing.bill_missing" } })).toBe(0);
  h.clock.advance(60_000);
  await run();
  const alert = await h.prisma.alertEvent.findFirstOrThrow({
    where: { fingerprint: `billing.bill_missing:${day}` },
  });
  expect(alert).toMatchObject({ kind: "probe", severity: "P2", status: "open", okStreak: 0 });
  h.clock.advance(60_000);
  await run();
  expect(await h.prisma.alertEvent.findUniqueOrThrow({ where: { id: alert.id } })).toMatchObject({
    status: "open",
    okStreak: 0,
  });
  const file = await original(day, sourceBill(day, []));
  h.clock.advance(60_000);
  await run();
  await run();
  expect(await h.prisma.alertEvent.findUniqueOrThrow({ where: { id: alert.id } })).toMatchObject({
    status: "open",
    okStreak: 1,
  });
  h.clock.advance(60_000);
  await run();
  h.clock.advance(60_000);
  await run();
  expect(await h.prisma.alertEvent.findUniqueOrThrow({ where: { id: alert.id } })).toMatchObject({
    status: "resolved",
    okStreak: 3,
  });
  await zero();
  await h.prisma.wxBillFile.update({ where: { id: file.id }, data: { lineCount: 1 } });
  expect(
    await h.tx.run((tx) => reconciliationInvariants[0]!.run!(tx, {}, { now: h.clock.now() })),
  ).toMatchObject([{ subject: { type: "wx_bill_file", id: file.id } }]);
  await h.prisma.wxBillFile.update({ where: { id: file.id }, data: { lineCount: 0 } });
  const row = await h.prisma.reconDay.findUniqueOrThrow({
    where: { billDate_channel: { billDate: dateValue(day), channel: "wechat_jsapi" } },
  });
  await h.prisma.reconDay.update({
    where: { id: row.id },
    data: { status: "ok", platformPayCount: 1 },
  });
  expect(
    await h.tx.run((tx) => reconciliationInvariants[1]!.run!(tx, {}, { now: h.clock.now() })),
  ).toMatchObject([{ subject: { type: "recon_day", id: row.id } }]);
  await h.prisma.reconDay.update({
    where: { id: row.id },
    data: { status: "wait", platformPayCount: 0 },
  });
  const entered = barrier(),
    release = barrier();
  const held = underDay(h.deps, day, async () => {
    entered.resolve();
    await release.promise;
  });
  void held.catch(entered.reject);
  await entered.promise;
  try {
    await expect(
      underDay(h.deps, day, (signal) => importDay(h.deps, day, signal)),
    ).rejects.toMatchObject({ error: "BUSY" });
  } finally {
    release.resolve();
    await held;
  }
  expect(await h.prisma.wxBillFile.count({ where: { billDate: dateValue(day) } })).toBe(1);
  await zero();
}, 60_000);
it("收款金额差1分与未知退款分别开精确差异，不能据账单擅补成功或改真实资金", async () => {
  const own = await h.paid(),
    day = calendarDate(h.clock.now());
  h.clock.advance(86_400_000);
  await original(
    day,
    sourceBill(day, [
      {
        outTradeNo: own.receipt.outTradeNo,
        transactionId: own.receipt.channelTxnNo!,
        amountFen: own.receipt.channelAmountFen! + 1,
      },
      {
        outTradeNo: own.receipt.outTradeNo,
        transactionId: own.receipt.channelTxnNo!,
        refund: { outRefundNo: "RF-UNKNOWN-1", refundId: "wx-rf-unknown", applicationFen: 123 },
      },
    ]),
  );
  const stable = financial.filter((v) => v !== "payment_txn" && v !== "billing_order"),
    before = await snapshotTables(h.prisma, stable);
  const result = await rerun(day);
  expect(result.result).toMatchObject({ status: "diff", diff: { count: 2, amountFen: "124" } });
  expect(await h.prisma.paymentException.findMany({ orderBy: { kind: "asc" } })).toMatchObject([
    { kind: "amount_mismatch", amountFen: 1, status: "open" },
    { kind: "refund_bill_only", amountFen: 123, status: "open" },
  ]);
  expect(await snapshotTables(h.prisma, stable)).toEqual(before);
  expect(
    await h.prisma.paymentTxn.findUniqueOrThrow({ where: { id: own.receipt.id } }),
  ).toMatchObject({
    status: "succeeded",
    channelAmountFen: own.receipt.channelAmountFen,
    refundedFen: 0,
  });
  expect(h.provider.wechatPay.callsOf("queryRefund")).toHaveLength(0);
  expect(h.provider.wechatPay.callsOf("queryByOutTradeNo")).toHaveLength(0);
  await zero();
});
