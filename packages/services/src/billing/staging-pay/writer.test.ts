import { afterEach, beforeEach, expect, it } from "vitest";
import { calendarDate } from "@liyoxi/shared/time";
import { approvalKindPort, createApproval } from "../../approval/index.js";
import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import type { Assembly, KeyedPort } from "../../kernel/index.js";
import {
  applyReceipt,
  createRefundHarnessForTest,
  pendingWechatReceipt,
  refundIdempotencyForTest,
  snapshotTables,
  useSeededDatabase,
} from "../../testing/index.js";
import type { RefundHarnessForTest } from "../../testing/index.js";
import type { RefundDeps } from "../refund/context.js";
import { recordRefundResult } from "../refund/result.js";
import { stagingRefundApproval } from "./kind.js";
import { STAGING_REFUND_JOB, STAGING_REFUND_KIND } from "./guards.js";
import { createStagingRefunds } from "./writer.js";

const db = useSeededDatabase("services", { max: 1, label: "stgrefund" });
let h: RefundHarnessForTest;
let fault: string | null;
beforeEach(async () => {
  await db.reset();
  fault = null;
  h = createRefundHarnessForTest(await db.prisma(), {
    onRefundStep: (step) => {
      if (step === fault) throw new Error(`系统退款断点:${step}`);
    },
  });
}, 60_000);
afterEach(() => h?.close());

// 只组装本片真实kind；生产registry/job在后继checkpoint接线，不能拿本夹具证明已装配。
function bind(policy: RefundDeps["stagingPay"]) {
  const kind = stagingRefundApproval(() => deps);
  const assembly: Assembly = {
    ...h.assembly,
    portEntries<T>(port: KeyedPort<T>) {
      const entries = new Map(h.assembly.portEntries(port));
      if (port === (approvalKindPort as unknown as KeyedPort<T>))
        entries.set(STAGING_REFUND_KIND, kind as unknown as T);
      return entries;
    },
  };
  const deps: RefundDeps = {
    ...h.deps,
    ...(policy ? { stagingPay: policy } : {}),
    assembly,
    approval: createApproval({ ...h.deps, assembly }),
  };
  return { deps, service: createStagingRefunds(deps) };
}
async function paid(amountFen: number, prefix = "TFK") {
  const own = await h.make.merchant({ verified: true });
  const plan = await h.prisma.plan.findUniqueOrThrow({ where: { code: "pro" } });
  const revision = await h.prisma.planRevision.findFirstOrThrow({
    where: { planId: plan.id, cancelledAt: null },
    orderBy: { revisionNo: "desc" },
  });
  const order = await h.make.billingOrder({
    entityId: own.entity.id,
    orderNo: `${prefix}2026010190001`,
    channel: "wechat_jsapi",
    status: "pending_payment",
    transferState: null,
    amountFen,
    contentSnapshot: {
      v: 1,
      kind: "plan",
      planId: plan.id,
      planRevisionId: revision.id,
      months: 1,
      cyclePriceFen: revision.monthlyFeeFen,
      payFen: amountFen,
      monthlyPoints: revision.monthlyPoints,
      discountBp: revision.discountBp,
      promo: null,
      quotedAt: h.clock.now().toISOString(),
    },
  });
  const receipt = await pendingWechatReceipt(h, order);
  const provider = h.provider.wechatPay;
  const pending = await provider.createJsapiOrder({
    outTradeNo: receipt.outTradeNo,
    description: "公开预发小额隔离样例",
    amountFen,
    payerOpenid: receipt.payerOpenid!,
    attach: receipt.attach!,
    expireAt: order.expiresAt,
  });
  if (!pending.ok) throw new Error("公开替身预下单失败");
  const fact = provider.pay(receipt.outTradeNo);
  if (fact.kind !== "transaction") throw new Error("公开替身支付事实缺失");
  // 先经正式可信收款口，再经同一入账/履约机制；不写成功状态。
  const { recordChannelSuccess } = await import("../index.js");
  const ctx = createIdentityContext({
    actor: { type: "system", job: STAGING_REFUND_JOB },
    entityId: own.entity.id,
  });
  await h.tx.run((tx) =>
    recordChannelSuccess(
      tx,
      {
        clock: h.clock,
        events: h.deps.events,
        appid: h.deps.wechatPay!.appid,
        mchid: h.deps.wechatPay!.mchid,
        exceptions: h.deps,
      },
      ctx,
      { paymentTxnId: receipt.id, transaction: fact.transaction },
    ),
  );
  await applyReceipt(h, receipt);
  h.clock.advance(600_000);
  return { ...own, order, receipt, ctx };
}
const financial = [
  "refund_request",
  "refund_txn",
  "approval_request",
  "billing_order",
  "payment_txn",
  "subscription_term",
  "point_lot",
  "point_ledger_entry",
  "ledger_operation",
  "grant_schedule",
  "invoice_request",
  "status_transition",
  "outbox_event",
  "idempotency_record",
];
it.each([1, 100])(
  "%i分经真实system审批与同一Saga退款，永久申请/执行单重放不增",
  async (amountFen) => {
    const r = await paid(amountFen);
    const { deps, service } = bind({ APP_ENV: "stg", STAGING_PAY: { entityIds: [r.entity.id] } });
    const result = await service.refundOrder(r.ctx, r.order.id);
    const request = await h.prisma.refundRequest.findUniqueOrThrow({
      where: { id: result.refundRequestId },
      include: { approvalRequest: true },
    });
    expect(request).toMatchObject({
      source: "staging_probe",
      amountFen,
      reasonCode: null,
      ruleCode: "window",
      isOverride: false,
      executedByStaffId: null,
      isExecutedBySystem: true,
      status: "executing",
      approvalRequest: {
        kind: STAGING_REFUND_KIND,
        submitActorType: "system",
        submitActorId: null,
        requesterStaffId: null,
        requesterStaffGroupId: null,
        status: "approved",
        isDecidedBySystem: true,
        decidedByStaffId: null,
      },
    });
    const txn = await h.prisma.refundTxn.findFirstOrThrow({
      where: { refundRequestId: request.id },
    });
    expect(txn).toMatchObject({ amountFen, submitCount: 1, status: "processing" });
    const histories = await h.prisma.statusTransition.findMany({
      where: { subjectId: { in: [request.id, request.approvalRequestId] } },
      orderBy: { seq: "asc" },
    });
    expect(histories.length).toBeGreaterThanOrEqual(5);
    expect(
      histories.every(
        (row) => row.actorType === "system" && row.actorId === null && row.client === null,
      ),
    ).toBe(true);
    await service.refundOrder(r.ctx, r.order.id);
    h.provider.wechatPay.completeRefund(txn.outRefundNo, { status: "SUCCESS" });
    const fact = await h.provider.wechatPay.queryRefund({ outRefundNo: txn.outRefundNo });
    if (!fact.ok) throw new Error("公开替身退款事实缺失");
    await h.tx.run((tx) =>
      recordRefundResult(tx, deps, r.ctx, {
        refundTxnId: txn.id,
        fact: fact.value,
        detectedBy: "query",
      }),
    );
    expect((await service.refundOrder(r.ctx, r.order.id)).status).toBe("done");
    // 模拟24h后技术缓存清理；只删本片幂等记录，永久业务事实原样保留。
    h.clock.advance(86_400_001);
    const cleared = await h.prisma.idempotencyRecord.deleteMany({
      where: {
        scope: { in: ["submit", "approve", "execute"].map((step) => `stg.pay.autorefund.${step}`) },
      },
    });
    expect(cleared.count).toBe(3);
    expect((await service.refundOrder(r.ctx, r.order.id)).refundRequestId).toBe(request.id);
    expect(await h.prisma.refundRequest.count({ where: { billingOrderId: r.order.id } })).toBe(1);
    expect(await h.prisma.refundTxn.count({ where: { refundRequestId: request.id } })).toBe(1);
    expect(h.provider.wechatPay.callsOf("createRefund")).toHaveLength(1);
    expect(
      (await h.prisma.paymentTxn.findUniqueOrThrow({ where: { id: r.receipt.id } })).refundedFen,
    ).toBe(amountFen);
    expect(
      (
        await h.prisma.subscriptionTerm.findFirstOrThrow({
          where: { sourceBillingOrderId: r.order.id },
        })
      ).status,
    ).toBe("refunded");
  },
);
it.each(["prod", "empty", "entity", "amount", "prefix", "too_soon"])(
  "%s保护拒绝且零渠道/业务写",
  async (mode) => {
    const r = await paid(mode === "amount" ? 101 : 1, mode === "prefix" ? "FK" : "TFK");
    if (mode === "too_soon") h.clock.set(new Date(h.clock.now().getTime() - 1));
    const { service } = bind({
      APP_ENV: mode === "prod" ? "prod" : "stg",
      STAGING_PAY: {
        entityIds: mode === "empty" ? [] : [mode === "entity" ? uuidv7() : r.entity.id],
      },
    });
    const before = await snapshotTables(h.prisma, financial);
    await expect(service.refundOrder(r.ctx, r.order.id)).rejects.toMatchObject({
      error: ["prod", "empty"].includes(mode) ? "PERMISSION_DENIED" : "PRECONDITION_CHANGED",
    });
    expect(await snapshotTables(h.prisma, financial)).toEqual(before);
    expect(h.provider.wechatPay.callsOf("createRefund")).toHaveLength(0);
    expect(h.provider.wechatPay.callsOf("queryRefund")).toHaveLength(0);
  },
);
it("外呼后丢应答恢复先查原号；撤掉白名单也不能借旧执行键绕过", async () => {
  const r = await paid(1);
  const { service } = bind({ APP_ENV: "stg", STAGING_PAY: { entityIds: [r.entity.id] } });
  fault = "external";
  await expect(service.refundOrder(r.ctx, r.order.id)).rejects.toThrow("系统退款断点:external");
  const txn = await h.prisma.refundTxn.findFirstOrThrow({ where: { billingOrderId: r.order.id } });
  const revoked = await h.prisma.ledgerOperation.count({
    where: { opKey: { startsWith: "revoke:subscription_term:" } },
  });
  h.clock.advance(30_001);
  const disabled = bind({ APP_ENV: "stg", STAGING_PAY: { entityIds: [] } });
  const before = await snapshotTables(h.prisma, financial);
  await expect(disabled.service.refundOrder(r.ctx, r.order.id)).rejects.toMatchObject({
    error: "PERMISSION_DENIED",
  });
  expect(await snapshotTables(h.prisma, financial)).toEqual(before);
  expect(h.provider.wechatPay.callsOf("queryRefund")).toHaveLength(0);
  fault = null;
  await service.refundOrder(r.ctx, r.order.id);
  expect(h.provider.wechatPay.callsOf("createRefund")).toHaveLength(1);
  expect(h.provider.wechatPay.callsOf("queryRefund").map((call) => call.input)).toEqual([
    { outRefundNo: txn.outRefundNo },
  ]);
  expect(await h.prisma.refundTxn.count({ where: { billingOrderId: r.order.id } })).toBe(1);
  expect(
    await h.prisma.ledgerOperation.count({
      where: { opKey: { startsWith: "revoke:subscription_term:" } },
    }),
  ).toBe(revoked);
});

it("真实系统待执行申请不接受人工线下登记，明确拒绝且零业务写", async () => {
  const r = await paid(1);
  const { service } = bind({ APP_ENV: "stg", STAGING_PAY: { entityIds: [r.entity.id] } });
  // 在真实意图事务提交前中断；系统审批已经提交，权益与渠道意图整笔回滚。
  fault = "intent";
  await expect(service.refundOrder(r.ctx, r.order.id)).rejects.toThrow("系统退款断点:intent");
  fault = null;
  const request = await h.prisma.refundRequest.findFirstOrThrow({
    where: { billingOrderId: r.order.id },
    include: { approvalRequest: true },
  });
  expect(request).toMatchObject({ status: "pending_execution", isExecutedBySystem: false });
  const staff = await h.staff();
  const file = await h.make.fileObject({
    category: "pay_receipt",
    bucket: "secure",
    scopeType: "entity",
    entityId: r.entity.id,
    uploadActorType: "staff",
    uploadActorId: staff.row.id,
    uploadClient: "admin",
  });
  const body = {
    confirm: { requestNo: request.approvalRequest.requestNo!, amountFen: request.amountFen },
    confirmChecks: ["offline_transfer_checked"],
    transferDate: calendarDate(h.clock.now()),
    bankSerialNo: "STGOFFLINE0001",
    payeeName: r.entity.name!,
    payeeBank: "隔离测试银行",
    payeeAccount: "6217000000000000001",
    receiptFileId: file.id,
    note: "公开替身线下登记拒绝用例",
  };
  const before = await snapshotTables(h.prisma, financial);
  await expect(
    h.service.recordOffline(
      staff.ctx,
      staff.staff,
      request.id,
      body,
      refundIdempotencyForTest(staff.ctx, "admin.refundRequest.recordOffline", body),
    ),
  ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
  expect(await snapshotTables(h.prisma, financial)).toEqual(before);
  expect(h.provider.wechatPay.callsOf("createRefund")).toHaveLength(0);
});
