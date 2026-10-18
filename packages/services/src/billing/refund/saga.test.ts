import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPrismaClient } from "@liyoxi/db";
import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import { snapshotTables, useSeededDatabase } from "../../testing/index.js";
import { createRefundHarness, refundIdem } from "./test.fixture.js";
import type { RefundHarness } from "./test.fixture.js";
import { refundInvariants } from "./invariants.js";
import { recordRefundResult } from "./result.js";

const handle = useSeededDatabase("services", { max: 1, label: "refundsaga" });
let h: RefundHarness;
let fault: string | null = null;
beforeEach(async () => {
  fault = null;
  await handle.reset();
  h = createRefundHarness(await handle.prisma(), {
    onRefundStep: (step) => {
      if (step === fault) throw new Error(`退款断点:${step}`);
    },
  });
}, 60_000);
afterEach(() => h?.close());
const financial = [
  "refund_request",
  "refund_txn",
  "payment_txn",
  "billing_order",
  "subscription_term",
  "point_lot",
  "point_ledger_entry",
  "ledger_operation",
  "grant_schedule",
  "approval_request",
  "status_transition",
  "outbox_event",
];
async function zero(entityId: string) {
  for (const rule of refundInvariants)
    expect(
      await h.tx.run((tx) => rule.run!(tx, { entityIds: [entityId] }, { now: h.clock.now() })),
      rule.code,
    ).toEqual([]);
}
const current = (id: string) =>
  h.prisma.refundTxn.findFirstOrThrow({
    where: { refundRequestId: id },
    orderBy: { createdAt: "desc" },
  });
it("E1拒绝与意图内中断零半写；提交后外呼/E2中断恢复沿原单号且权益只一次", async () => {
  const r = await h.approved(),
    body = h.executeBody(r),
    key = uuidv7(),
    before = await snapshotTables(h.prisma, financial);
  fault = "intent";
  await expect(h.execute(r, key)).rejects.toThrow("退款断点:intent");
  expect(await snapshotTables(h.prisma, financial)).toEqual(before);
  fault = "external";
  await expect(h.execute(r, key)).rejects.toThrow("退款断点:external");
  const first = await current(r.created.refundRequestId);
  expect(first).toMatchObject({ status: "created", submitCount: 1 });
  expect(
    await h.prisma.subscriptionTerm.findFirstOrThrow({
      where: { sourceBillingOrderId: r.order.id },
    }),
  ).toMatchObject({ status: "refunded", refundRequestId: null });
  const revoked = await h.prisma.ledgerOperation.count({
    where: { opKey: { startsWith: "revoke:subscription_term:" } },
  });
  expect(revoked).toBe(1);
  h.clock.advance(30_001);
  fault = "result";
  await expect(
    h.service.execute(
      r.executor.ctx,
      r.executor.staff,
      r.created.refundRequestId,
      body,
      refundIdem(r.executor.ctx, "admin.refundRequest.execute", body, key),
    ),
  ).rejects.toThrow("退款断点:result");
  expect((await current(r.created.refundRequestId)).outRefundNo).toBe(first.outRefundNo);
  h.clock.advance(30_001);
  fault = null;
  const recovered = await h.execute(r, key);
  expect(recovered.status).toBe("executing");
  expect(
    await h.prisma.refundTxn.count({ where: { refundRequestId: r.created.refundRequestId } }),
  ).toBe(1);
  await h.result(first.id);
  await h.result(first.id);
  expect((await h.service.get(r.executor.staff, r.created.refundRequestId)).status).toBe("done");
  expect(
    (await h.prisma.paymentTxn.findUniqueOrThrow({ where: { id: r.receipt.id } })).refundedFen,
  ).toBe(r.receipt.channelAmountFen);
  expect(
    await h.prisma.ledgerOperation.count({
      where: { opKey: { startsWith: "revoke:subscription_term:" } },
    }),
  ).toBe(1);
  await zero(r.entity.id);
});
it("回调先于E2/重复查询不回写成功；可信事实提交中断可完整重放", async () => {
  const r = await h.approved(),
    real = h.provider.wechatPay.createRefund.bind(h.provider.wechatPay);
  h.provider.wechatPay.createRefund = async (input) => {
    const reply = await real(input);
    const txn = await h.prisma.refundTxn.findUniqueOrThrow({
      where: { outRefundNo: input.outRefundNo },
    });
    await h.result(txn.id);
    return reply;
  };
  const result = await h.execute(r);
  expect(result.status).toBe("done");
  const txn = await current(r.created.refundRequestId);
  expect(txn.status).toBe("succeeded");
  await zero(r.entity.id);
  const second = await h.approved();
  h.provider.wechatPay.createRefund = real;
  await h.execute(second);
  const s = await current(second.created.refundRequestId);
  fault = "success";
  await expect(h.result(s.id)).rejects.toThrow("退款断点:success");
  expect(
    (await h.prisma.paymentTxn.findUniqueOrThrow({ where: { id: second.receipt.id } })).refundedFen,
  ).toBe(0);
  fault = null;
  await h.result(s.id);
  await zero(second.entity.id);
});
it("失败后不恢复权益/不准作废；晚到旧成功保留，另笔在途不迁申请，超退真实报I5并开差异", async () => {
  const r = await h.approved();
  await h.execute(r);
  const first = await current(r.created.refundRequestId);
  await h.result(first.id, "CLOSED");
  expect((await h.service.get(r.executor.staff, r.created.refundRequestId)).status).toBe(
    "pending_execution",
  );
  const voidBody = {
    confirm: { requestNo: r.created.requestNo, amountFen: r.created.amountFen },
    note: "失败后不得恢复已回收权益",
  };
  await expect(
    h.service.void(
      r.approver.ctx,
      r.approver.staff,
      r.created.refundRequestId,
      voidBody,
      refundIdem(r.approver.ctx, "admin.refundRequest.void", voidBody),
    ),
  ).rejects.toMatchObject({ error: "REFUND_ALREADY_REVOKED" });
  await h.execute(r);
  const second = await current(r.created.refundRequestId);
  expect(second.id).not.toBe(first.id);
  await h.result(first.id);
  expect((await h.service.get(r.executor.staff, r.created.refundRequestId)).status).toBe(
    "executing",
  );
  expect(
    (await h.prisma.refundTxn.findUniqueOrThrow({ where: { id: first.id } })).isLateSuccess,
  ).toBe(true);
  // 支付替身禁止超额新申请；已经真实受理的第二笔可晚到SUCCESS，不压掉事实。
  await h.result(second.id);
  const payment = await h.prisma.paymentTxn.findUniqueOrThrow({ where: { id: r.receipt.id } });
  expect(payment.refundedFen).toBe(2 * r.created.amountFen);
  expect(
    await h.prisma.paymentException.count({
      where: { paymentTxnId: r.receipt.id, kind: "refund_over" },
    }),
  ).toBe(1);
  const findings = await h.tx.run((tx) =>
    refundInvariants.find((i) => i.code === "payment.I5")!.run!(
      tx,
      { entityIds: [r.entity.id] },
      { now: h.clock.now() },
    ),
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.detail).toMatchObject({ successful: 2 * r.created.amountFen });
});
it("未执行驳回/撤回/作废恢复闸门，余额不丢；超窗只限发起而非批准", async () => {
  for (const action of ["reject", "withdraw", "void"] as const) {
    const r = await h.request(),
      before = (
        await h.prisma.billingAccount.findUniqueOrThrow({ where: { entityId: r.entity.id } })
      ).planAvailableQty;
    const id = r.created.refundRequestId;
    if (action === "void") {
      const b = {
        lockVersion: 0,
        confirm: { requestNo: r.created.requestNo, amountFen: r.created.amountFen },
        confirmChecks: ["rule_amount_checked"],
      };
      await h.service.approve(
        r.approver.ctx,
        r.approver.staff,
        id,
        b,
        refundIdem(r.approver.ctx, "admin.refundRequest.approve", b),
      );
      const v = { confirm: b.confirm, note: "执行前关闭退款申请恢复闸门" };
      await h.service.void(
        r.approver.ctx,
        r.approver.staff,
        id,
        v,
        refundIdem(r.approver.ctx, "admin.refundRequest.void", v),
      );
    } else if (action === "reject") {
      const b = { note: "核对后驳回该退款申请", reasonCodes: ["other"] };
      await h.service.reject(
        r.approver.ctx,
        r.approver.staff,
        id,
        b,
        refundIdem(r.approver.ctx, "admin.refundRequest.reject", b),
      );
    } else {
      const b = { note: "申请人撤回退款申请" };
      await h.service.withdraw(
        r.creator.ctx,
        r.creator.staff,
        id,
        b,
        refundIdem(r.creator.ctx, "admin.refundRequest.withdraw", b),
      );
    }
    expect(
      (await h.prisma.billingAccount.findUniqueOrThrow({ where: { entityId: r.entity.id } }))
        .planAvailableQty,
    ).toBe(before);
    expect(
      (
        await h.prisma.subscriptionTerm.findFirstOrThrow({
          where: { sourceBillingOrderId: r.order.id },
        })
      ).refundRequestId,
    ).toBeNull();
    await zero(r.entity.id);
  }
  const r = await h.request();
  h.clock.advance(8 * 86_400_000);
  r.approver.staff = { ...r.approver.staff, stepUpAt: h.clock.now() };
  const b = {
    lockVersion: 0,
    confirm: { requestNo: r.created.requestNo, amountFen: r.created.amountFen },
    confirmChecks: ["rule_amount_checked"],
  };
  expect(
    (
      await h.service.approve(
        r.approver.ctx,
        r.approver.staff,
        r.created.refundRequestId,
        b,
        refundIdem(r.approver.ctx, "admin.refundRequest.approve", b),
      )
    ).status,
  ).toBe("pending_execution");
});
it("同申请两独立连接并发执行三轮：仅一个真实渠道号/一次回收", async () => {
  const db2 = createPrismaClient({ connectionString: await handle.url(), max: 1 }),
    other = createRefundHarness(db2, { clock: h.clock, providers: h.provider });
  try {
    for (let round = 0; round < 3; round++) {
      const r = await h.approved(),
        body = h.executeBody(r);
      const results = await Promise.allSettled([
        h.execute(r),
        other.service.execute(
          r.executor.ctx,
          r.executor.staff,
          r.created.refundRequestId,
          body,
          refundIdem(r.executor.ctx, "admin.refundRequest.execute", body),
        ),
      ]);
      expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(1);
      expect(
        await h.prisma.refundTxn.count({ where: { refundRequestId: r.created.refundRequestId } }),
      ).toBe(1);
      const t = await current(r.created.refundRequestId);
      await h.result(t.id);
      await zero(r.entity.id);
    }
  } finally {
    other.close();
    await db2.$disconnect();
  }
});
it("未受理凭证须真实签名notFound且停止重试10分钟，网络404不释放未知态", async () => {
  const r = await h.approved();
  h.provider.wechatPay.failNext("createRefund", { reason: "unavailable", times: 2 });
  await h.execute(r);
  const txn = await current(r.created.refundRequestId),
    body = { confirm: { requestNo: r.created.requestNo, outRefundNo: txn.outRefundNo } };
  const failQuery = async () => ({
    ok: false as const,
    status: "ready" as const,
    reason: "rejected" as const,
    message: "404",
  });
  h.provider.wechatPay.queryRefund = failQuery;
  h.clock.advance(30_001);
  const retry = await h.service.retry(
    r.executor.ctx,
    r.executor.staff,
    r.created.refundRequestId,
    body,
    refundIdem(r.executor.ctx, "admin.refundRequest.retry", body),
  );
  expect(retry.status).toBe("executing");
  h.clock.advance(600_001);
  r.executor.staff = { ...r.executor.staff, stepUpAt: h.clock.now() };
  await expect(
    h.service.confirmNotAccepted(
      r.executor.ctx,
      r.executor.staff,
      r.created.refundRequestId,
      body,
      refundIdem(r.executor.ctx, "admin.refundRequest.confirmNotAccepted", body),
    ),
  ).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
  expect((await current(r.created.refundRequestId)).status).toBe("created");
  h.provider.wechatPay.queryRefund = async () => ({
    ok: false,
    status: "ready",
    reason: "rejected",
    refundNotFound: true,
    message: "已验签RESOURCE_NOT_EXISTS",
  });
  await h.service.confirmNotAccepted(
    r.executor.ctx,
    r.executor.staff,
    r.created.refundRequestId,
    body,
    refundIdem(r.executor.ctx, "admin.refundRequest.confirmNotAccepted", body),
  );
  expect((await current(r.created.refundRequestId)).status).toBe("not_accepted");
  await zero(r.entity.id);
});
it("金额不一致累加原交易金额并独立记渠道事实，非本单/未来成功时间拒绝零写", async () => {
  const r = await h.approved();
  await h.execute(r);
  const txn = await current(r.created.refundRequestId),
    fact = {
      outRefundNo: txn.outRefundNo,
      outTradeNo: r.receipt.outTradeNo,
      refundId: "wx-refund-amount",
      status: "SUCCESS" as const,
      refundFen: txn.amountFen - 1,
      successAt: h.clock.now(),
    },
    ctx = createIdentityContext({ actor: { type: "system", job: "lyxtest.refund" } });
  await expect(
    h.tx.run((tx) =>
      recordRefundResult(tx, h.deps, ctx, {
        refundTxnId: txn.id,
        fact: { ...fact, outTradeNo: "foreign" },
        detectedBy: "query",
      }),
    ),
  ).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
  await expect(
    h.tx.run((tx) =>
      recordRefundResult(tx, h.deps, ctx, {
        refundTxnId: txn.id,
        fact: { ...fact, successAt: new Date(h.clock.now().getTime() + 1) },
        detectedBy: "query",
      }),
    ),
  ).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
  await h.tx.run((tx) =>
    recordRefundResult(tx, h.deps, ctx, { refundTxnId: txn.id, fact, detectedBy: "query" }),
  );
  expect(
    (await h.prisma.paymentTxn.findUniqueOrThrow({ where: { id: r.receipt.id } })).refundedFen,
  ).toBe(txn.amountFen);
  expect(
    await h.prisma.paymentException.findFirstOrThrow({
      where: { refundTxnId: txn.id, kind: "refund_amount_mismatch" },
    }),
  ).toMatchObject({
    billFact: { amountFen: fact.refundFen },
    platformFact: { amountFen: txn.amountFen },
  });
  await zero(r.entity.id);
});

it("真实未入账重复收款转申请：服务端核额，经审批退款只改该回单，付款单/发票不动", async () => {
  const own = await h.paid(),
    finance = await h.staff(),
    approver = await h.staff(),
    executor = await h.staff();
  // 第二笔同付款单支付由渠道成功事实+正式applyPayment分类成duplicate_receipt，非伪造退款状态。
  const { pendingWechatReceipt } = await import("../../testing/index.js");
  const { recordChannelSuccess } = await import("../payment/channel-success.js");
  const { submitExceptionRefund } = await import("./exception.js");
  const second = await pendingWechatReceipt(h, { ...own.order, status: "pending_payment" }, 2);
  await h.provider.wechatPay.createJsapiOrder({
    outTradeNo: second.outTradeNo,
    description: "重复回单退款验证",
    amountFen: second.amountFen,
    payerOpenid: second.payerOpenid!,
    attach: second.attach!,
    expireAt: own.order.expiresAt,
  });
  const paid = h.provider.wechatPay.pay(second.outTradeNo);
  if (paid.kind !== "transaction") throw new Error("付款事实错误");
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
      createIdentityContext({ actor: { type: "system", job: "lyxtest.duplicate" } }),
      { paymentTxnId: second.id, transaction: paid.transaction },
    ),
  );
  await h.tx.run((tx) => h.deps.payment.applyPayment(tx, { paymentTxnId: second.id }));
  const exception = await h.prisma.paymentException.findFirstOrThrow({
    where: { paymentTxnId: second.id, kind: "duplicate_receipt" },
  });
  const input = {
    paymentExceptionId: exception.id,
    note: "真实重复入账回单原路退款",
    confirm: { exceptionNo: exception.exceptionNo, amountFen: exception.amountFen },
  };
  const created = await h.tx.run((tx) =>
    submitExceptionRefund(tx, h.deps, finance.ctx, finance.staff, input, null),
  );
  const originalOrder = await h.prisma.billingOrder.findUniqueOrThrow({
    where: { id: own.order.id },
  });
  const body = {
    lockVersion: 0,
    confirm: { requestNo: created.requestNo, amountFen: created.amountFen },
    confirmChecks: ["rule_amount_checked"],
  };
  await h.service.approve(
    approver.ctx,
    approver.staff,
    created.refundRequestId,
    body,
    refundIdem(approver.ctx, "admin.refundRequest.approve", body),
  );
  const execute = {
    confirm: {
      requestNo: created.requestNo,
      amountFen: created.amountFen,
      channelTxnNo: paid.transaction.transactionId!,
    },
    confirmChecks: ["original_txn_checked"],
  };
  await h.service.execute(
    executor.ctx,
    executor.staff,
    created.refundRequestId,
    execute,
    refundIdem(executor.ctx, "admin.refundRequest.execute", execute),
  );
  const txn = await current(created.refundRequestId);
  await h.result(txn.id);
  const after = await h.prisma.billingOrder.findUniqueOrThrow({ where: { id: own.order.id } });
  expect(after.status).toBe(originalOrder.status);
  expect(after.refundedAmountFen).toBe(0);
  expect(after.paidPaymentTxnId).toBe(own.receipt.id);
  expect(
    (await h.prisma.paymentTxn.findUniqueOrThrow({ where: { id: own.receipt.id } })).refundedFen,
  ).toBe(0);
  expect(
    (await h.prisma.paymentTxn.findUniqueOrThrow({ where: { id: second.id } })).refundedFen,
  ).toBe(second.amountFen);
  expect(
    await h.prisma.paymentException.findUniqueOrThrow({ where: { id: exception.id } }),
  ).toMatchObject({ status: "resolved", refundRequestId: created.refundRequestId });
  await zero(own.entity.id);
});

it("线下登记使用真实media规则与唯一流水，失败零写、成功永久回单且回收一次", async () => {
  const r = await h.approved(),
    body = {
      confirm: { requestNo: r.created.requestNo, amountFen: r.created.amountFen },
      confirmChecks: ["offline_transfer_checked"],
      transferDate: h.clock.now().toISOString().slice(0, 10),
      bankSerialNo: "W410-OFFLINE-0001",
      payeeName: r.entity.name!,
      payeeBank: "公开测试银行",
      payeeAccount: "6222000000000000",
      receiptFileId: "00000000-0000-7000-8000-000000000001",
      note: "原微信付款改线下转账，已人工核对",
    };
  const before = await snapshotTables(h.prisma, financial);
  await expect(
    h.service.recordOffline(
      r.executor.ctx,
      r.executor.staff,
      r.created.refundRequestId,
      body,
      refundIdem(r.executor.ctx, "admin.refundRequest.recordOffline", body),
    ),
  ).rejects.toMatchObject({ error: "FILE_NOT_USABLE" });
  expect(await snapshotTables(h.prisma, financial)).toEqual(before);
  const file = await h.make.fileObject({
    category: "pay_receipt",
    scopeType: "entity",
    entityId: r.entity.id,
    uploadActorType: "staff",
    uploadActorId: r.executor.row.id,
    status: "stored",
    moderationState: "pass",
  });
  body.receiptFileId = file.id;
  const done = await h.service.recordOffline(
    r.executor.ctx,
    r.executor.staff,
    r.created.refundRequestId,
    body,
    refundIdem(r.executor.ctx, "admin.refundRequest.recordOffline", body),
  );
  expect(done.status).toBe("done");
  const txn = await current(done.refundRequestId);
  expect(txn).toMatchObject({ channel: "offline", status: "succeeded", receiptFileId: file.id });
  expect(txn.payeeAccountEnc).not.toContain(body.payeeAccount);
  expect(
    await h.prisma.fileRef.findFirstOrThrow({
      where: { refType: "refund_txn", refId: txn.id, role: "receipt" },
    }),
  ).toMatchObject({ state: "live", keepUntil: null });
  await zero(r.entity.id);
});

it("双人放弃只允许异常交易：真实会话认证，同人/过期/错误角色/凭证不合法零写", async () => {
  const { createTestStaffAuth, signInAsStaff } = await import("../../testing/index.js"),
    auth = createTestStaffAuth(h.prisma, { clock: h.clock });
  const r = await h.approved();
  await h.execute(r);
  const txn = await current(r.created.refundRequestId);
  await h.result(txn.id, "ABNORMAL");
  const finance = await signInAsStaff(h.prisma, { roleKey: "finance", now: h.clock.now() }),
    admin = await signInAsStaff(h.prisma, { roleKey: "super_admin", now: h.clock.now() }),
    editor = await signInAsStaff(h.prisma, { roleKey: "editor", now: h.clock.now() });
  const first = await auth.staff.authenticate(finance.sessionToken),
    second = await auth.staff.authenticate(admin.sessionToken),
    outsider = await auth.staff.authenticate(editor.sessionToken);
  const body = {
    refundTxnId: txn.id,
    evidenceFileId: "00000000-0000-7000-8000-000000000002",
    note: "官方确认此异常退款无法继续",
    financeConfirm: { requestNo: r.created.requestNo, outRefundNo: txn.outRefundNo },
    administratorConfirm: { requestNo: r.created.requestNo, outRefundNo: txn.outRefundNo },
  };
  const before = await snapshotTables(h.prisma, financial);
  await expect(
    h.service.abandon({ finance: first, administrator: first }, body),
  ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
  await expect(
    h.service.abandon({ finance: first, administrator: outsider }, body),
  ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
  await expect(
    h.service.abandon({ finance: first, administrator: second }, body),
  ).rejects.toMatchObject({ error: "FILE_NOT_USABLE" });
  expect(await snapshotTables(h.prisma, financial)).toEqual(before);
  await h.prisma.staffSession.update({
    where: { id: second.session.id },
    data: { revokedAt: h.clock.now() },
  });
  await expect(
    h.service.abandon({ finance: first, administrator: second }, body),
  ).rejects.toMatchObject({ error: "SESSION_INVALID" });
  expect(await snapshotTables(h.prisma, financial)).toEqual(before);
  const activeAdmin = await signInAsStaff(h.prisma, { roleKey: "super_admin", now: h.clock.now() }),
    currentAdmin = await auth.staff.authenticate(activeAdmin.sessionToken);
  const file = await h.make.fileObject({
    category: "pay_receipt",
    scopeType: "entity",
    entityId: r.entity.id,
    uploadActorType: "staff",
    uploadActorId: finance.staff.id,
    status: "stored",
    moderationState: "pass",
  });
  body.evidenceFileId = file.id;
  expect(
    await h.service.abandon({ finance: first, administrator: currentAdmin }, body),
  ).toMatchObject({ status: "abandoned" });
  expect((await h.service.get(r.executor.staff, r.created.refundRequestId)).status).toBe(
    "pending_execution",
  );
  expect(
    await h.prisma.auditLog.findFirstOrThrow({
      where: { action: "finance.refund.abandon_txn", targetId: txn.id },
    }),
  ).toMatchObject({
    meta: {
      financeStaffId: finance.staff.id,
      administratorStaffId: activeAdmin.staff.id,
      evidenceFileId: file.id,
    },
  });
  await h.result(txn.id);
  expect((await current(r.created.refundRequestId)).isLateSuccess).toBe(true);
  await zero(r.entity.id);
});

it("预约退款前移后续周期以根取消事件保存真实快照，daily重建保留创建史与费用", async () => {
  const { computeEntityDaily } = await import("../reporting/daily.js");
  const { calendarDate } = await import("@liyoxi/shared/time");
  // 合法参数没有上限1：本例显式配置3个预约名额，只构造两笔真实后续已收款周期。
  await h.prisma.billingParam.create({
    data: {
      id: uuidv7(),
      key: "maxScheduledTerms",
      value: 3,
      effectiveAt: h.clock.now(),
      changeId: uuidv7(),
      note: "退款历史边界的合法隔离配置",
      createdAt: h.clock.now(),
    },
  });
  const own = await h.paid(),
    middle = await h.paid(own),
    tail = await h.paid(own);
  const target = await h.prisma.subscriptionTerm.findFirstOrThrow({
      where: { sourceBillingOrderId: middle.order.id },
    }),
    last = await h.prisma.subscriptionTerm.findFirstOrThrow({
      where: { sourceBillingOrderId: tail.order.id },
    });
  const creator = await h.staff("super_admin"),
    approver = await h.staff(),
    executor = await h.staff(),
    reason = await h.refundReason(),
    create = {
      ruleCode: "window" as const,
      reasonCode: reason.code,
      confirm: { orderNo: middle.order.orderNo, amountFen: middle.order.paidAmountFen },
    };
  const request = await h.service.create(
    creator.ctx,
    creator.staff,
    middle.order.id,
    create,
    refundIdem(creator.ctx, "admin.paymentOrder.refundRequest.create", create),
  );
  const approve = {
    lockVersion: 0,
    confirm: { requestNo: request.requestNo, amountFen: request.amountFen },
    confirmChecks: ["rule_amount_checked"],
  };
  await h.service.approve(
    approver.ctx,
    approver.staff,
    request.refundRequestId,
    approve,
    refundIdem(approver.ctx, "admin.refundRequest.approve", approve),
  );
  const execute = {
    confirm: { ...approve.confirm, channelTxnNo: middle.receipt.channelTxnNo! },
    confirmChecks: ["original_txn_checked"],
  };
  await h.service.execute(
    executor.ctx,
    executor.staff,
    request.refundRequestId,
    execute,
    refundIdem(executor.ctx, "admin.refundRequest.execute", execute),
  );
  const moved = await h.prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: last.id } });
  expect(moved.status).toBe("scheduled");
  expect(moved.startsAt).toEqual(target.startsAt);
  const event = await h.prisma.subscriptionEvent.findFirstOrThrow({
    where: { subscriptionTermId: target.id, type: "cancelled" },
  });
  expect(event.payload).toMatchObject({
    affectedTerms: [
      { termId: last.id, status: "scheduled", startsAt: moved.startsAt.toISOString() },
    ],
  });
  const day = calendarDate(h.clock.now());
  h.clock.advance(86_400_000);
  const daily = await h.tx.run((tx) => computeEntityDaily(tx, own.entity.id, day, h.clock.now()));
  expect(daily.days.at(-1)).toMatchObject({
    subscriptionTermId: (
      await h.prisma.subscriptionTerm.findFirstOrThrow({
        where: { sourceBillingOrderId: own.order.id },
      })
    ).id,
    deferredPlanFeeFen: tail.order.paidAmountFen,
  });
  // 只读负例模拟旧史缺创建记录；不删除或更新只增的真实历史。
  await h.tx.run(async (tx) => {
    const records = await tx.subscriptionEvent.findMany({
      where: { entityId: own.entity.id },
      orderBy: [{ bizDate: "asc" }, { seq: "asc" }],
    });
    const source = vi
      .spyOn(tx.subscriptionEvent, "findMany")
      .mockResolvedValue(
        records.filter(
          (e) => !(e.subscriptionTermId === last.id && e.type === "renewal_scheduled"),
        ),
      );
    try {
      await expect(computeEntityDaily(tx, own.entity.id, day, h.clock.now())).rejects.toMatchObject(
        { name: "BillingDailyHistoryMissingError" },
      );
    } finally {
      source.mockRestore();
    }
  });
});

it("日历更新只重算未执行待办，旧timer取消/同状态历史原子，重复乱序和失败后不重启", async () => {
  const { createCalendarAdmin } = await import("../../sla/index.js"),
    { onRefundCalendarImported } = await import("./calendar.js");
  const r = await h.approved(),
    id = r.created.refundRequestId,
    before = await h.prisma.refundRequest.findUniqueOrThrow({ where: { id } }),
    original = await h.prisma.timer.findFirstOrThrow({
      where: {
        subjectId: before.approvalRequestId,
        kind: "sla.breach",
        dedupeKey: { endsWith: ":execution" },
        status: "scheduled",
      },
    });
  const admin = createCalendarAdmin({ tx: h.tx, clock: h.clock, events: h.deps.events }),
    actor = { identity: r.creator.ctx, staff: r.creator.staff };
  const result = await admin.import(actor, {
    year: 2026,
    source: "隔离测试日历批次",
    days: [{ date: "2026-01-06", kind: "holiday", note: "测试假日" }],
  });
  const events = await h.prisma.outboxEvent.findMany({
      where: { eventType: "calendar.imported" },
      orderBy: { seq: "desc" },
    }),
    latest = events[0]!;
  const event = {
    id: latest.id,
    type: latest.eventType,
    payload: latest.payload as Record<string, unknown>,
  };
  expect(result.isChanged).toBe(true);
  await h.tx.run((tx) => onRefundCalendarImported(tx, h.deps, event));
  const changed = await h.prisma.refundRequest.findUniqueOrThrow({ where: { id } });
  expect(changed.execDueAt!.getTime()).toBeGreaterThan(before.execDueAt!.getTime());
  expect(changed.slaSnapshot).toMatchObject({
    calendarVersion: (event.payload as { calendarVersion: number }).calendarVersion,
  });
  expect((await h.prisma.timer.findUniqueOrThrow({ where: { id: original.id } })).status).toBe(
    "cancelled",
  );
  const count = await h.prisma.statusTransition.count({
    where: { machine: "refund_request", subjectId: id, event: "sla.recalculated" },
  });
  expect(count).toBe(1);
  await h.tx.run((tx) => onRefundCalendarImported(tx, h.deps, event));
  await h.tx.run((tx) =>
    onRefundCalendarImported(tx, h.deps, {
      ...event,
      payload: { ...event.payload, calendarVersion: 0 },
    }),
  );
  expect(
    await h.prisma.statusTransition.count({
      where: { machine: "refund_request", subjectId: id, event: "sla.recalculated" },
    }),
  ).toBe(count);
  await h.execute(r);
  const txn = await current(id);
  await h.result(txn.id, "CLOSED");
  await admin.import(actor, {
    year: 2026,
    source: "隔离测试日历第二批次",
    days: [{ date: "2026-01-07", kind: "holiday", note: "后续假日" }],
  });
  const newer = await h.prisma.outboxEvent.findFirstOrThrow({
    where: { eventType: "calendar.imported" },
    orderBy: { seq: "desc" },
  });
  await h.tx.run((tx) =>
    onRefundCalendarImported(tx, h.deps, {
      id: newer.id,
      type: newer.eventType,
      payload: newer.payload as Record<string, unknown>,
    }),
  );
  expect((await h.prisma.refundRequest.findUniqueOrThrow({ where: { id } })).execDueAt).toEqual(
    changed.execDueAt,
  );
  expect(
    await h.prisma.timer.count({
      where: {
        subjectId: before.approvalRequestId,
        kind: "sla.breach",
        dedupeKey: { endsWith: ":execution" },
        status: "scheduled",
      },
    }),
  ).toBe(0);
});
