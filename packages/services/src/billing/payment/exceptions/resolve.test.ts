import { afterEach, beforeEach, expect, it } from "vitest";
import type { BillingOrder, PaymentTxn } from "@liyoxi/db";
import { PaymentExceptionResolveBodySchema } from "@liyoxi/contract";
import type { PaymentExceptionKindCode, PaymentResolutionCode } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { createIdentityContext, uuidv7 } from "../../../kernel/index.js";
import {
  createRefundHarnessForTest,
  refundIdempotencyForTest,
  pendingPlanOrder,
  pendingWechatReceipt,
  snapshotTables,
  useSeededDatabase,
  captureHold,
} from "../../../testing/index.js";
import type { RefundHarnessForTest } from "../../../testing/index.js";
import {
  createFulfillment,
  createPayment,
  recordChannelSuccess,
  wechatOrderAttach,
  billingInvariants,
  paymentInvariants,
} from "../../index.js";
import { refundInvariants } from "../../refund/invariants.js";
import { createPaymentExceptions } from "./index.js";
import { openFact } from "./facts.js";
import { resolutions } from "./matrix.js";
import { decodeAttach } from "./rebuild.js";

const db = useSeededDatabase("services", { max: 2, label: "exceptions" });
let h: RefundHarnessForTest, service: ReturnType<typeof createPaymentExceptions>;
const tables = [
  "billing_order",
  "payment_txn",
  "refund_txn",
  "refund_request",
  "approval_request",
  "payment_exception",
  "status_transition",
  "audit_log",
  "outbox_event",
  "ledger_operation",
  "point_ledger_entry",
  "subscription_term",
  "point_lot",
  "grant_schedule",
  "file_ref",
];
beforeEach(async () => {
  await db.reset();
  h = createRefundHarnessForTest(await db.prisma());
  service = createPaymentExceptions({ ...h.deps, fulfillment: h.fulfillment });
}, 60_000);
afterEach(() => h?.close());
type Operator = Awaited<ReturnType<typeof h.staff>>;
const body = (
  row: { exceptionNo: string; amountFen: number; lockVersion: number },
  resolution: PaymentResolutionCode,
) => ({
  lockVersion: row.lockVersion,
  resolution,
  note: "已核对真实渠道与平台事实",
  confirm: { exceptionNo: row.exceptionNo, amountFen: row.amountFen },
});
async function resolve(
  actor: Operator,
  id: string,
  resolution: PaymentResolutionCode,
  key = uuidv7(),
  extra = {},
) {
  const row = await h.prisma.paymentException.findUniqueOrThrow({ where: { id } });
  const input = PaymentExceptionResolveBodySchema.parse({ ...body(row, resolution), ...extra });
  return service.resolve(
    actor.ctx,
    actor.staff,
    id,
    input,
    refundIdempotencyForTest(actor.ctx, "admin.paymentException.resolve", input, key),
  );
}
async function open(
  kind: PaymentExceptionKindCode,
  receipt: PaymentTxn,
  order: BillingOrder | null,
  extra: { wxBillLineId?: string; amountFen?: number } = {},
) {
  return h.tx.run((tx) =>
    openFact(
      tx,
      { ...h.deps, fulfillment: h.fulfillment },
      createIdentityContext({ actor: { type: "system", job: "lyxtest.exception" } }),
      {
        kind,
        dedupeKey: `${kind}:lyxtest:${uuidv7()}`,
        entityId: receipt.entityId,
        billingOrderId: order?.id ?? null,
        paymentTxnId: receipt.id,
        amountFen: extra.amountFen ?? receipt.channelAmountFen!,
        detectedBy: "query",
        causeText: "隔离渠道事实与平台事实需处理",
        ...extra,
      },
    ),
  );
}
async function zeroFinancialInvariants(entityId: string) {
  for (const rule of [...billingInvariants, ...paymentInvariants, ...refundInvariants])
    expect(
      await h.tx.run((tx) => rule.run!(tx, { entityIds: [entityId] }, { now: h.clock.now() })),
      rule.code,
    ).toEqual([]);
}
async function channelPayment(order: BillingOrder, apply = true, attempt = 1) {
  const receipt = await pendingWechatReceipt(h, order, attempt);
  expect(
    (
      await h.provider.wechatPay.createJsapiOrder({
        outTradeNo: receipt.outTradeNo,
        description: "差异真实渠道前置",
        amountFen: order.amountFen,
        payerOpenid: receipt.payerOpenid!,
        attach: receipt.attach!,
        expireAt: order.expiresAt,
      })
    ).ok,
  ).toBe(true);
  const notification = h.provider.wechatPay.pay(receipt.outTradeNo);
  if (notification.kind !== "transaction") throw new Error("非收款事实");
  await h.tx.run((tx) =>
    recordChannelSuccess(
      tx,
      {
        clock: h.clock,
        events: h.events,
        appid: h.deps.wechatPay!.appid,
        mchid: h.deps.wechatPay!.mchid,
        exceptions: h.deps,
      },
      createIdentityContext({ actor: { type: "system", job: "lyxtest.channel" } }),
      { paymentTxnId: receipt.id, transaction: notification.transaction },
    ),
  );
  if (apply) await h.tx.run((tx) => h.payment.applyPayment(tx, { paymentTxnId: receipt.id }));
  return h.prisma.paymentTxn.findUniqueOrThrow({ where: { id: receipt.id } });
}
it("14类型的固定矩阵、关联bill_only与核销权限准确；每一非法方式/版本/回显零业务写", async () => {
  // a07§4.3正式矩阵独立期望；不从生产策略表取期望，防止实现与断言一同漂移。
  const expected = {
    paid_after_cancel: ["restore", "refund"],
    amount_mismatch: ["refund"],
    payer_mismatch: ["refund"],
    duplicate_receipt: ["refund"],
    fulfillment_blocked: ["retried", "refund"],
    bill_only: ["rebuild_order", "refund"],
    bank_unmatched: ["link_order", "offline_return"],
    platform_only: ["corrected"],
    status_mismatch: ["corrected"],
    refund_bill_only: ["record_channel_refund"],
    refund_platform_only: ["corrected"],
    refund_amount_mismatch: ["corrected"],
    refund_over: ["corrected", "written_off"],
    entitlement_unrecovered: ["corrected", "written_off"],
  } satisfies Record<PaymentExceptionKindCode, PaymentResolutionCode[]>;
  const actor = await h.staff(),
    admin = await h.staff("super_admin"),
    own = await h.paid();
  for (const [kind, allowed] of Object.entries(expected)) {
    const key = kind as PaymentExceptionKindCode;
    expect(
      resolutions(
        { kind, status: "open", billingOrderId: kind === "bill_only" ? null : own.order.id },
        admin.staff,
      ),
    ).toEqual(allowed);
    expect(resolutions({ kind, status: "resolving", billingOrderId: null }, admin.staff)).toEqual(
      [],
    );
    const id = await open(key, own.receipt, key === "bill_only" ? null : own.order),
      row = await h.prisma.paymentException.findUniqueOrThrow({ where: { id } });
    const illegal = key === "bank_unmatched" ? "corrected" : "offline_return";
    const input = {
      ...body(row, illegal),
      ...(illegal === "offline_return"
        ? {
            offlineReturn: {
              transferDate: calendarDate(h.clock.now()),
              bankSerialNo: "NEGATIVE",
              payeeName: "隔离户名",
              payeeBank: "隔离银行",
              payeeAccount: "6222000000000000",
              receiptFileId: uuidv7(),
            },
          }
        : {}),
    };
    const before = await snapshotTables(h.prisma, tables);
    await expect(
      service.resolve(
        actor.ctx,
        actor.staff,
        id,
        input,
        refundIdempotencyForTest(actor.ctx, "admin.paymentException.resolve", input),
      ),
    ).rejects.toMatchObject({ error: "RESOLUTION_NOT_ALLOWED" });
    expect(await snapshotTables(h.prisma, tables), kind).toEqual(before);
  }
  expect(
    resolutions({ kind: "bill_only", status: "open", billingOrderId: own.order.id }, admin.staff),
  ).toEqual([]);
  const id = await open("refund_over", own.receipt, own.order),
    row = await h.prisma.paymentException.findUniqueOrThrow({ where: { id } });
  const before = await snapshotTables(h.prisma, tables);
  await expect(resolve(actor, id, "written_off")).rejects.toMatchObject({
    error: "PERMISSION_DENIED",
  });
  for (const patch of [
    { lockVersion: row.lockVersion + 1 },
    { confirm: { exceptionNo: row.exceptionNo, amountFen: row.amountFen + 1 } },
  ]) {
    const input = { ...body(row, "corrected"), ...patch };
    await expect(
      service.resolve(
        admin.ctx,
        admin.staff,
        id,
        input,
        refundIdempotencyForTest(admin.ctx, "admin.paymentException.resolve", input),
      ),
    ).rejects.toMatchObject({
      error: "lockVersion" in patch ? "VERSION_CONFLICT" : "CONFIRM_MISMATCH",
    });
  }
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  const fixed = await resolve(admin, id, "written_off");
  expect(fixed).toMatchObject({ status: "resolved", resolution: "written_off" });
});
it("未入账重复收款转真实审批并resolving；同键不增单，撤回沿W410重开且不动原发票/权益", async () => {
  const actor = await h.staff("super_admin"),
    own = await h.paid();
  const blue = await h.issueBlue(own, actor);
  const receipt = await channelPayment({ ...own.order, status: "pending_payment" }, true, 2),
    row = await h.prisma.paymentException.findFirstOrThrow({
      where: { kind: "duplicate_receipt", paymentTxnId: receipt.id },
    });
  const input = { ...body(row, "refund"), note: "退" },
    key = uuidv7(),
    beforeTerm = await h.prisma.subscriptionTerm.findFirstOrThrow({
      where: { sourceBillingOrderId: own.order.id },
    });
  const call = () =>
    service.resolve(
      actor.ctx,
      actor.staff,
      row.id,
      input,
      refundIdempotencyForTest(actor.ctx, "admin.paymentException.resolve", input, key),
    );
  const result = await call();
  expect(result).toMatchObject({
    status: "resolving",
    resolution: "refund",
    outcome: "refund_requested",
    refundRequest: { status: "pending_approval" },
  });
  expect(await call()).toEqual(result);
  expect(await h.prisma.refundRequest.count({ where: { paymentTxnId: receipt.id } })).toBe(1);
  const requestId = result.refundRequest!.refundRequestId;
  const withdraw = { note: "财务撤回后重新核对" };
  await h.service.withdraw(
    actor.ctx,
    actor.staff,
    requestId,
    withdraw,
    refundIdempotencyForTest(actor.ctx, "admin.refundRequest.withdraw", withdraw),
  );
  expect(await service.get(actor.staff, row.id)).toMatchObject({
    status: "open",
    resolution: "none",
    resolutionNote: null,
    resolvedBy: null,
    refundRequest: null,
  });
  expect(await h.prisma.subscriptionTerm.findUnique({ where: { id: beforeTerm.id } })).toEqual(
    beforeTerm,
  );
  expect(
    await h.prisma.invoiceRequest.findUnique({ where: { id: blue.request.invoiceRequestId } }),
  ).toMatchObject({ status: "issued", heldByRefundRequestId: null });
  expect(await h.prisma.billingOrder.findUnique({ where: { id: own.order.id } })).toMatchObject({
    status: "paid",
    refundedAmountFen: 0,
  });
});

async function refundBill(
  own: Awaited<ReturnType<typeof h.paid>>,
  outRefundNo: string,
  actor: Operator,
) {
  const queried = await h.provider.wechatPay.queryRefund({ outRefundNo });
  if (!queried.ok || !queried.value.successAt) throw new Error("缺真实外部退款事实");
  const fact = queried.value,
    day = new Date(`${calendarDate(fact.successAt!)}T00:00:00Z`),
    now = h.clock.now();
  let file = await h.prisma.wxBillFile.findFirst({
    where: { mchid: h.deps.wechatPay!.mchid, billDate: day },
  });
  if (!file) {
    const archive = await h.make.fileObject({
      category: "pay_bill",
      scopeType: "platform",
      entityId: null,
      uploadActorType: "staff",
      uploadActorId: actor.row.id,
      uploadClient: "admin",
      status: "stored",
      moderationState: "pass",
    });
    file = await h.prisma.wxBillFile.create({
      data: {
        id: uuidv7(),
        mchid: h.deps.wechatPay!.mchid,
        billDate: day,
        billType: "trade_all",
        status: "parsed",
        fileId: archive.id,
        downloadedAt: now,
        isHashVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  const line = await h.prisma.wxBillLine.create({
    data: {
      id: uuidv7(),
      wxBillFileId: file.id,
      lineNo: (await h.prisma.wxBillLine.count({ where: { wxBillFileId: file.id } })) + 1,
      billDate: day,
      lineKind: "refund",
      tradedAt: fact.successAt!,
      appid: h.deps.wechatPay!.appid,
      mchid: h.deps.wechatPay!.mchid,
      transactionId: own.receipt.channelTxnNo!,
      outTradeNo: own.receipt.outTradeNo,
      tradeState: "REFUND",
      orderAmountFen: own.receipt.channelAmountFen!,
      settleAmountFen: own.receipt.channelAmountFen!,
      refundId: fact.refundId,
      outRefundNo,
      refundAmountFen: fact.refundFen,
      refundState: fact.status,
      feeFen: 0,
      rateText: "0",
      isForeign: false,
      matchState: "diff",
      createdAt: now,
      updatedAt: now,
    },
  });
  return open("refund_bill_only", own.receipt, own.order, {
    wxBillLineId: line.id,
    amountFen: fact.refundFen,
  });
}
async function external(
  own: Awaited<ReturnType<typeof h.paid>>,
  outRefundNo: string,
  status: "SUCCESS" | "CLOSED" = "SUCCESS",
) {
  expect(
    (
      await h.provider.wechatPay.createRefund({
        outTradeNo: own.receipt.outTradeNo,
        outRefundNo,
        totalFen: own.receipt.channelAmountFen!,
        refundFen: own.receipt.channelAmountFen!,
        reason: "隔离商户平台退款",
      })
    ).ok,
  ).toBe(true);
  h.provider.wechatPay.completeRefund(outRefundNo, { status });
}
it("真实渠道外部退款回收整周期且蓝票待红冲；原已关闭退款晚到成功保留超退资金与差异", async () => {
  const actor = await h.staff("super_admin"),
    own = await h.paid(),
    blue = await h.issueBlue(own, actor);
  await external(own, "EXTERNAL-CLOSED-1", "CLOSED");
  await external(own, "EXTERNAL-SUCCESS-2");
  const id = await refundBill(own, "EXTERNAL-SUCCESS-2", actor),
    row = await h.prisma.paymentException.findUniqueOrThrow({ where: { id } }),
    input = body(row, "record_channel_refund"),
    key = uuidv7();
  const call = () =>
    service.resolve(
      actor.ctx,
      actor.staff,
      id,
      input,
      refundIdempotencyForTest(actor.ctx, "admin.paymentException.resolve", input, key),
    );
  expect(await call()).toMatchObject({
    status: "resolved",
    refundTxn: { origin: "external", status: "succeeded" },
  });
  await call();
  expect(
    await h.prisma.subscriptionTerm.findFirst({ where: { sourceBillingOrderId: own.order.id } }),
  ).toMatchObject({ status: "refunded", refundRequestId: null });
  expect(
    await h.prisma.ledgerOperation.findFirst({
      where: { opKey: { startsWith: "revoke:subscription_term:" } },
    }),
  ).toMatchObject({ refType: "payment_exception", refId: id });
  expect(
    await h.prisma.invoiceRequest.findUnique({ where: { id: blue.request.invoiceRequestId } }),
  ).toMatchObject({ status: "red_pending" });
  h.provider.wechatPay.completeRefund("EXTERNAL-CLOSED-1");
  const late = await refundBill(own, "EXTERNAL-CLOSED-1", actor);
  await resolve(actor, late, "record_channel_refund");
  expect(await h.prisma.paymentTxn.findUnique({ where: { id: own.receipt.id } })).toMatchObject({
    refundedFen: own.order.amountFen * 2,
  });
  expect(
    await h.prisma.paymentException.findFirst({
      where: { kind: "refund_over", paymentTxnId: own.receipt.id },
    }),
  ).toMatchObject({ status: "open", amountFen: own.order.amountFen });
  expect(
    await h.prisma.ledgerOperation.count({
      where: { opKey: { startsWith: "revoke:subscription_term:" } },
    }),
  ).toBe(1);
  await zeroFinancialInvariants(own.entity.id);
});
it("外部退款遇真实在途退款闸门不回收/不清标记；现金保留并另开未回收差异", async () => {
  const request = await h.request(),
    actor = await h.staff("super_admin"),
    term = await h.prisma.subscriptionTerm.findFirstOrThrow({
      where: { sourceBillingOrderId: request.order.id },
    });
  expect(term.refundRequestId).toBe(request.created.refundRequestId);
  const before = await snapshotTables(h.prisma, [
    "subscription_term",
    "point_lot",
    "point_ledger_entry",
    "ledger_operation",
    "grant_schedule",
  ]);
  await external(request, "EXTERNAL-GATED-1");
  const id = await refundBill(request, "EXTERNAL-GATED-1", actor);
  await resolve(actor, id, "record_channel_refund");
  expect(
    await snapshotTables(h.prisma, [
      "subscription_term",
      "point_lot",
      "point_ledger_entry",
      "ledger_operation",
      "grant_schedule",
    ]),
  ).toEqual(before);
  expect(
    await h.prisma.refundRequest.findUnique({ where: { id: request.created.refundRequestId } }),
  ).toMatchObject({ status: "pending_approval", closedAt: null });
  expect(await h.prisma.paymentTxn.findUnique({ where: { id: request.receipt.id } })).toMatchObject(
    { refundedFen: request.order.amountFen },
  );
  expect(
    await h.prisma.paymentException.findFirst({
      where: { kind: "entitlement_unrecovered", paymentTxnId: request.receipt.id },
    }),
  ).toMatchObject({ status: "open", platformFact: { text: "refund_gate_held" } });
  await zeroFinancialInvariants(request.entity.id);
});
it("灾备孤儿按真实查单attach重建新建→paid并真实履约；升级编码/金额不符不能造单", async () => {
  const actor = await h.staff("super_admin"),
    own = await h.make.merchant({ verified: true });
  const template = await pendingPlanOrder(h, { entityId: own.entity.id, channel: "wechat_jsapi" });
  // 从真实价目模板取快照，但这个原订单ID/单号从未插入本库，模拟恢复点后缺失的业务行。
  const original = {
    ...template,
    id: uuidv7(),
    orderNo: await h.tx.run((tx) => h.deps.bizNo.next(tx, "FK")),
  };
  const attempt = {
    id: uuidv7(),
    outTradeNo: `${original.orderNo}-01-A1B2C3`,
    payerOpenid: `o_test_${own.entity.id}`,
    attach: wechatOrderAttach(original)!,
  };
  expect(
    (
      await h.provider.wechatPay.createJsapiOrder({
        outTradeNo: attempt.outTradeNo,
        description: "灾备孤儿真实渠道前置",
        amountFen: original.amountFen,
        payerOpenid: attempt.payerOpenid!,
        attach: attempt.attach!,
        expireAt: original.expiresAt,
      })
    ).ok,
  ).toBe(true);
  const notification = h.provider.wechatPay.pay(attempt.outTradeNo);
  if (notification.kind !== "transaction") throw new Error("非收款事实");
  const fact = notification.transaction;
  const receipt = await h.make.paymentTxn({
    id: attempt.id,
    entityId: null,
    billingOrderId: null,
    channel: "wechat_jsapi",
    outTradeNo: fact.outTradeNo,
    amountFen: fact.amountFen!,
    channelAmountFen: fact.amountFen!,
    channelTxnNo: fact.transactionId!,
    channelPayerRef: fact.payerOpenid!,
    channelAttach: fact.attach!,
    channelSuccessAt: fact.successAt!,
    reconState: "diff",
  });
  const id = await open("bill_only", receipt, null);
  expect(() => decodeAttach(attempt.attach!.replace(".N.", ".U."))).toThrow();
  h.provider.wechatPay.setQueryResult(receipt.outTradeNo, {
    ...fact,
    amountFen: fact.amountFen! - 1,
  });
  const before = await snapshotTables(h.prisma, tables);
  await expect(resolve(actor, id, "rebuild_order")).rejects.toMatchObject({
    error: "CHANNEL_RECHECK_FAILED",
  });
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  h.provider.wechatPay.setQueryResult(receipt.outTradeNo, null);
  h.clock.advance(60_000);
  const result = await resolve(actor, id, "rebuild_order");
  expect(result).toMatchObject({
    status: "resolved",
    paymentOrder: { paymentOrderId: original.id },
  });
  expect(await h.prisma.billingOrder.findUnique({ where: { id: original.id } })).toMatchObject({
    status: "paid",
    source: "weapp",
    createdByStaffId: actor.row.id,
    placedByUserId: null,
    rebuiltFrom: receipt.outTradeNo,
    fulfillmentStatus: "done",
    appliedAt: h.clock.now(),
  });
  expect(
    await h.prisma.statusTransition.findFirst({
      where: { machine: "billing_order", subjectId: original.id },
    }),
  ).toMatchObject({ fromState: null, toState: "paid", event: "billing_order.rebuild" });
  expect(
    await h.prisma.ledgerOperation.count({
      where: { opKey: `fulfill:billing_order:${original.id}` },
    }),
  ).toBe(1);
});
it("升级后外部退款回收整个原周期；已消耗与冻结的积分不强释，未回收数量真实另开差异", async () => {
  const actor = await h.staff("super_admin"),
    own = await h.paid();
  await h.paid(own, { planCode: "flagship", intent: "upgrade_now" });
  const hold = () =>
    h.tx.run((tx) =>
      h.ledger.hold(tx, {
        entityId: own.entity.id,
        storeId: own.store.id,
        refType: "ad",
        refId: uuidv7(),
        groupRef: "W411-AD",
        pricing: { kind: "ad" },
        title: { code: "ad_hold", args: { adNo: "W411-AD", unitPoints: 50, discountBp: 10000 } },
        ctx: createIdentityContext({
          actor: { type: "merchant", id: own.user.id, role: "owner", client: "weapp" },
          entityId: own.entity.id,
          storeId: own.store.id,
        }),
      }),
    );
  const first = await hold(),
    second = await hold();
  await captureHold(h, first.pointHoldId);
  await external(own, "EXTERNAL-UPGRADED-1");
  const id = await refundBill(own, "EXTERNAL-UPGRADED-1", actor);
  await resolve(actor, id, "record_channel_refund");
  const term = await h.prisma.subscriptionTerm.findFirstOrThrow({
    where: { sourceBillingOrderId: own.order.id },
  });
  expect(term.status).toBe("refunded");
  expect(await h.prisma.pointHold.findUnique({ where: { id: second.pointHoldId } })).toMatchObject({
    status: "held",
    qty: second.points,
  });
  const lots = await h.prisma.pointLot.findMany({ where: { subscriptionTermId: term.id } });
  expect(lots.reduce((n, l) => n + l.availableQty + l.expiredQty, 0)).toBe(0);
  expect(lots.reduce((n, l) => n + l.heldQty + l.consumedQty + l.convertedOutQty, 0)).toBe(
    first.points + second.points,
  );
  expect(
    await h.prisma.paymentException.findFirst({
      where: { kind: "entitlement_unrecovered", paymentTxnId: own.receipt.id },
    }),
  ).toMatchObject({
    status: "open",
    platformFact: { unrecoveredPoints: first.points + second.points },
  });
  const history = await h.prisma.subscriptionEvent.findFirstOrThrow({
    where: { subscriptionTermId: term.id, type: "refunded" },
  });
  expect(history.payload).toMatchObject({
    paymentExceptionId: id,
    rule: "override",
    unrecoveredPoints: first.points + second.points,
  });
  expect(history.payload).not.toHaveProperty("refundRequestId");
  await zeroFinancialInvariants(own.entity.id);
});
it("登记真实孤儿对公到账后关联入账与单键重放；线下退回严格核户名/文件并永久关联回单", async () => {
  const actor = await h.staff("super_admin"),
    own = await h.make.merchant({ verified: true }),
    order = await pendingPlanOrder(h, {
      entityId: own.entity.id,
      channel: "bank_transfer",
      status: "pending_payment",
    });
  const input = {
      receivedAt: h.clock.now().toISOString(),
      amountFen: order.amountFen,
      payerName: own.entity.name!,
      bankSerialNo: "W411 BANK 0001",
      note: "登记隔离真实银行流水",
      confirm: { amountFen: order.amountFen, bankSerialNo: "W411 BANK 0001" },
    },
    key = uuidv7();
  const created = await service.create(
    actor.ctx,
    actor.staff,
    input,
    refundIdempotencyForTest(actor.ctx, "admin.paymentException.create", input, key),
  );
  expect(
    await service.create(
      actor.ctx,
      actor.staff,
      input,
      refundIdempotencyForTest(actor.ctx, "admin.paymentException.create", input, key),
    ),
  ).toEqual(created);
  expect(created).toMatchObject({ kind: "bank_unmatched", status: "open", entity: null });
  expect(created.paymentTxn!.outTradeNo.startsWith(`${created.exceptionNo}-`)).toBe(true);
  const linked = await resolve(actor, created.paymentExceptionId, "link_order", uuidv7(), {
    linkPaymentOrderId: order.id,
  });
  expect(linked).toMatchObject({ status: "resolved", entity: { entityId: own.entity.id } });
  expect(await h.prisma.billingOrder.findUnique({ where: { id: order.id } })).toMatchObject({
    status: "paid",
    fulfillmentStatus: "done",
    hasOpenException: false,
  });
  const secondInput = {
      ...input,
      bankSerialNo: "W411 BANK 0002",
      confirm: { ...input.confirm, bankSerialNo: "W411 BANK 0002" },
    },
    orphan = await service.create(
      actor.ctx,
      actor.staff,
      secondInput,
      refundIdempotencyForTest(actor.ctx, "admin.paymentException.create", secondInput),
    );
  const proof = {
    transferDate: calendarDate(h.clock.now()),
    bankSerialNo: "W411 RETURN 0001",
    payeeName: input.payerName,
    payeeBank: "公开隔离银行",
    payeeAccount: "6222000000000000",
    receiptFileId: uuidv7(),
  };
  let before = await snapshotTables(h.prisma, tables);
  await expect(
    resolve(actor, orphan.paymentExceptionId, "offline_return", uuidv7(), {
      offlineReturn: { ...proof, payeeName: "不匹配户名" },
    }),
  ).rejects.toMatchObject({ error: "PAYEE_NAME_MISMATCH" });
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  await expect(
    resolve(actor, orphan.paymentExceptionId, "offline_return", uuidv7(), { offlineReturn: proof }),
  ).rejects.toMatchObject({ error: "FILE_NOT_USABLE" });
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  const file = await h.make.fileObject({
    category: "pay_receipt",
    scopeType: "platform",
    entityId: null,
    uploadActorType: "staff",
    uploadActorId: actor.row.id,
    uploadClient: "admin",
    status: "stored",
    moderationState: "pass",
  });
  proof.receiptFileId = file.id;
  const result = await resolve(actor, orphan.paymentExceptionId, "offline_return", uuidv7(), {
    offlineReturn: proof,
  });
  expect(result).toMatchObject({
    status: "resolved",
    refundTxn: { channel: "offline", status: "succeeded" },
  });
  expect(
    await h.prisma.paymentTxn.findUnique({
      where: { id: orphan.paymentTxn!.paymentTransactionId },
    }),
  ).toMatchObject({ refundedFen: order.amountFen, appliedAt: null });
  expect(await h.prisma.fileRef.count({ where: { fileId: file.id, refType: "refund_txn" } })).toBe(
    1,
  );
  before = await snapshotTables(h.prisma, tables);
  await expect(
    resolve(actor, orphan.paymentExceptionId, "offline_return", uuidv7(), { offlineReturn: proof }),
  ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
});
it("取消后真实成功须C51重新查单；不可信查单零业务写，补单按当前时刻履约且保留取消痕迹", async () => {
  const actor = await h.staff("super_admin"),
    own = await h.make.merchant({ verified: true }),
    order = await pendingPlanOrder(h, { entityId: own.entity.id, channel: "wechat_jsapi" });
  const ctx = createIdentityContext({
    actor: { type: "merchant", id: own.user.id, role: "owner", client: "weapp" },
    entityId: own.entity.id,
    storeId: own.store.id,
  });
  await h.tx.run((tx) =>
    h.deps.flow.transition(tx, ctx, {
      machine: "billing_order",
      stateField: "status",
      id: order.id,
      event: "billing_order.cancel",
      ref: "08:166",
      reasonCode: "user",
      set: { cancelled_at: h.clock.now(), cancel_reason: "user" },
      emit: {
        type: "billing_order.cancelled",
        payload: { v: 1, billingOrderId: order.id, entityId: own.entity.id, cancelReason: "user" },
      },
      audit: {
        stream: "activity",
        category: "payment",
        action: "lyxtest.payment.cancel",
        summary: "真实取消入口",
        target: { type: "billing_order", id: order.id },
      },
    }),
  );
  const receipt = await channelPayment(order),
    row = await h.prisma.paymentException.findFirstOrThrow({
      where: { paymentTxnId: receipt.id, kind: "paid_after_cancel" },
    });
  const fact = await h.provider.wechatPay.queryByOutTradeNo({ outTradeNo: receipt.outTradeNo });
  if (!fact.ok) throw new Error("缺真实查询事实");
  h.provider.wechatPay.setQueryResult(receipt.outTradeNo, {
    ...fact.value,
    amountFen: order.amountFen + 1,
  });
  const before = await snapshotTables(h.prisma, tables);
  await expect(resolve(actor, row.id, "restore")).rejects.toMatchObject({
    error: "CHANNEL_RECHECK_FAILED",
  });
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  h.provider.wechatPay.setQueryResult(receipt.outTradeNo, null);
  h.clock.advance(60_000);
  expect(await resolve(actor, row.id, "restore")).toMatchObject({
    status: "resolved",
    resolution: "restore",
  });
  const saved = await h.prisma.billingOrder.findUniqueOrThrow({ where: { id: order.id } });
  expect(saved).toMatchObject({
    status: "paid",
    fulfillmentStatus: "done",
    cancelReason: "user",
    appliedAt: h.clock.now(),
  });
  expect(saved.cancelledAt).not.toBeNull();
  expect(
    (
      await h.prisma.subscriptionTerm.findFirstOrThrow({
        where: { sourceBillingOrderId: order.id },
      })
    ).startsAt,
  ).toEqual(h.clock.now());
});
it("真实履约保存点受阻可保持open，解除故障后重试完成；基础设施异常整TX回滚", async () => {
  const actor = await h.staff("super_admin"),
    own = await h.make.merchant({ verified: true }),
    order = await pendingPlanOrder(h, { entityId: own.entity.id, channel: "wechat_jsapi" }),
    receipt = await channelPayment(order, false);
  const failing = createFulfillment({
    clock: h.clock,
    events: h.events,
    onStep: (step) => {
      if (step === "term.insert") throw new Error("隔离履约断点");
    },
  });
  const payment = createPayment({ ...h.paymentDeps, fulfillment: failing });
  await h.tx.run((tx) => payment.applyPayment(tx, { paymentTxnId: receipt.id }));
  const row = await h.prisma.paymentException.findFirstOrThrow({
      where: { kind: "fulfillment_blocked", paymentTxnId: receipt.id },
    }),
    input = body(row, "retried");
  const blockedService = createPaymentExceptions({ ...h.deps, fulfillment: failing });
  expect(
    await blockedService.resolve(
      actor.ctx,
      actor.staff,
      row.id,
      input,
      refundIdempotencyForTest(actor.ctx, "admin.paymentException.resolve", input),
    ),
  ).toMatchObject({ outcome: "still_blocked", status: "open", resolution: "none" });
  const faultService = createPaymentExceptions({
    ...h.deps,
    fulfillment: {
      fulfill: async () => {
        throw Object.assign(new Error("ACCOUNT_BUSY"), { error: "ACCOUNT_BUSY" });
      },
    },
  });
  const before = await snapshotTables(h.prisma, tables);
  await expect(
    faultService.resolve(
      actor.ctx,
      actor.staff,
      row.id,
      input,
      refundIdempotencyForTest(actor.ctx, "admin.paymentException.resolve", input),
    ),
  ).rejects.toMatchObject({ error: "ACCOUNT_BUSY" });
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  expect(await resolve(actor, row.id, "retried")).toMatchObject({
    status: "resolved",
    resolution: "retried",
  });
  expect(
    await h.prisma.ledgerOperation.count({ where: { opKey: `fulfill:billing_order:${order.id}` } }),
  ).toBe(1);
});
it("相同版本并发结论只成功一次；同键返回冻结结果且旧版本/迟到动作不能改结论", async () => {
  const actor = await h.staff("super_admin"),
    own = await h.paid(),
    id = await open("status_mismatch", own.receipt, own.order),
    row = await h.prisma.paymentException.findUniqueOrThrow({ where: { id } }),
    input = body(row, "corrected"),
    key = uuidv7();
  const call = (key: string) =>
    service.resolve(
      actor.ctx,
      actor.staff,
      id,
      input,
      refundIdempotencyForTest(actor.ctx, "admin.paymentException.resolve", input, key),
    );
  const outcomes = await Promise.allSettled([call(key), call(uuidv7())]);
  expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const won = outcomes.findIndex((r) => r.status === "fulfilled");
  if (won === 0)
    expect(await call(key)).toEqual(
      (outcomes[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof call>>>).value,
    );
  expect(
    await h.prisma.statusTransition.count({
      where: { machine: "payment_exception", subjectId: id, event: "payment_exception.resolve" },
    }),
  ).toBe(1);
  expect(await h.prisma.paymentException.findUnique({ where: { id } })).toMatchObject({
    status: "resolved",
    lockVersion: 1,
  });
});
