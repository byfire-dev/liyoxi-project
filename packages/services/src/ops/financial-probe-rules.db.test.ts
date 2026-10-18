import { beforeEach, expect, it } from "vitest";
import { createPaymentHarness, pendingPlanOrder, useSeededDatabase } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import { financialProbeRules } from "./financial-probe-rules.js";

const db = useSeededDatabase("services", { max: 1 });
beforeEach(() => db.reset(), 60_000);
async function setup() {
  const h = createPaymentHarness(await db.prisma());
  const sample = () => financialProbeRules(h.prisma)[0]!.sample(h.clock.now());
  return { ...h, sample };
}

it("真实收款未入账或履约受阻按120/600秒严格分级，全退和履约完成不误报", async () => {
  const h = await setup(),
    now = h.clock.now();
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
  const receipt = await h.make.paymentTxn({ channelSuccessAt: ago(120) });
  await h.make.paymentTxn({ channelSuccessAt: ago(3600), refundedFen: 9900 });
  const done = await h.make.billingOrder();
  expect(await h.sample()).toEqual([]);
  h.clock.advance(1);
  expect(await h.sample()).toEqual([
    { rule: "billing.unfulfilled", severity: "P2", detail: { oldestAgeSec: 120.001 } },
  ]);
  h.clock.advance(479_999);
  expect(await h.sample()).toMatchObject([{ severity: "P2", detail: { oldestAgeSec: 600 } }]);
  h.clock.advance(1);
  expect(await h.sample()).toMatchObject([{ severity: "P1" }]);
  await h.prisma.paymentTxn.update({ where: { id: receipt.id }, data: { refundedFen: 9900 } });
  expect(await h.sample()).toEqual([]);
  // 重复收款不会因为目标付款单已经履约而被漏掉。
  const duplicate = await h.make.paymentTxn({
    billingOrderId: done.id,
    entityId: done.entityId,
    channelSuccessAt: ago(601),
  });
  expect(await h.sample()).toMatchObject([{ rule: "billing.unfulfilled", severity: "P1" }]);
  await h.prisma.paymentTxn.update({ where: { id: duplicate.id }, data: { refundedFen: 9900 } });
  await h.prisma.billingOrder.update({
    where: { id: done.id },
    data: { fulfillmentStatus: "blocked", fulfilledAt: null },
  });
  expect(await h.sample()).toMatchObject([{ rule: "billing.unfulfilled", severity: "P2" }]);
  await h.prisma.billingOrder.update({
    where: { id: done.id },
    data: { fulfillmentStatus: "done", fulfilledAt: h.clock.now() },
  });
  expect(await h.sample()).toEqual([]);
});

it("待支付逾期严格超过10分钟才报，待财务确认与已取消仍保持正常且采样零写", async () => {
  const h = await setup(),
    now = h.clock.now();
  const at = new Date(now.getTime() - 600_000);
  const pending = await h.make.billingOrder({ status: "pending_payment", expiresAt: at });
  await h.make.billingOrder({ status: "cancelled", expiresAt: at });
  const entity = await h.make.entity();
  const confirmation = await pendingPlanOrder(h, { entityId: entity.id });
  await h.prisma.billingOrder.update({
    where: { id: confirmation.id },
    data: { expiresAt: new Date(at.getTime() - 1) },
  });
  const before = await h.prisma.billingOrder.findMany({ orderBy: { id: "asc" } });
  expect(await h.sample()).toEqual([]);
  h.clock.advance(1);
  expect(await h.sample()).toEqual([
    { rule: "billing.expired_order", severity: "P2", detail: { count: 1 } },
  ]);
  expect(await h.prisma.billingOrder.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  expect(await h.prisma.auditLog.count()).toBe(0);
  await h.prisma.billingOrder.update({
    where: { id: pending.id },
    data: { status: "cancelled", cancelledAt: h.clock.now(), cancelReason: "timeout" },
  });
  expect(await h.sample()).toEqual([]);
});

it("真实退款交易的处理中三日边界、异常升级、终态排除及缺失查询结果不冒充健康", async () => {
  const h = await setup(),
    now = h.clock.now();
  const staff = await h.make.staff(),
    reviewer = await h.make.staff();
  const order = await h.make.billingOrder();
  const aid = uuidv7(),
    rid = uuidv7();
  await h.prisma.approvalRequest.create({
    data: {
      id: aid,
      requestNo: `TK${aid.replaceAll("-", "")}`,
      kind: "plan_refund",
      category: "approval",
      subjectType: "billing_order",
      subjectId: order.id,
      entityId: order.entityId,
      status: "approved",
      summarySnapshot: { title: "退款观测夹具" },
      requesterStaffId: staff.id,
      submitActorType: "staff",
      submitActorId: staff.id,
      submitClient: "admin",
      submittedAt: now,
      decidedAt: now,
      decidedByStaffId: reviewer.id,
      createdAt: now,
      updatedAt: now,
    },
  });
  await h.prisma.refundRequest.create({
    data: {
      id: rid,
      approvalRequestId: aid,
      source: "customer_service",
      entityId: order.entityId,
      billingOrderId: order.id,
      paymentTxnId: order.paidPaymentTxnId!,
      baseAmountFen: order.amountFen,
      amountFen: order.amountFen,
      breakdownSnapshot: {},
      ruleCode: "window",
      ruleText: "测试退款",
      reasonCode: "other",
      status: "executing",
      execRoute: "wechat_original",
      executedByStaffId: reviewer.id,
      executedAt: now,
      execDueAt: now,
      slaSnapshot: {},
      createdAt: now,
      updatedAt: now,
    },
  });
  const start = new Date(now.getTime() - 3 * 86_400_000);
  const refund = await h.prisma.refundTxn.create({
    data: {
      id: uuidv7(),
      entityId: order.entityId,
      refundRequestId: rid,
      billingOrderId: order.id,
      paymentTxnId: order.paidPaymentTxnId!,
      channel: "wechat_jsapi",
      origin: "system",
      outRefundNo: uuidv7().replaceAll("-", ""),
      amountFen: order.amountFen,
      status: "processing",
      lastSubmitAt: start,
      submitCount: 1,
      createdAt: start,
      updatedAt: now,
    },
  });
  expect(await h.sample()).toEqual([]);
  h.clock.advance(1);
  expect(await h.sample()).toEqual([
    {
      rule: "billing.refund_stuck",
      severity: "P2",
      detail: { processing: 1, abnormal: 0, createdFailed: 0 },
    },
  ]);
  await h.prisma.refundTxn.update({ where: { id: refund.id }, data: { status: "abnormal" } });
  expect(await h.sample()).toEqual([
    {
      rule: "billing.refund_stuck",
      severity: "P1",
      detail: { processing: 0, abnormal: 1, createdFailed: 0 },
    },
  ]);
  for (const status of ["closed", "not_accepted", "abandoned", "succeeded"]) {
    await h.prisma.refundTxn.update({
      where: { id: refund.id },
      data: { status, successAt: status === "succeeded" ? h.clock.now() : null },
    });
    expect(await h.sample()).toEqual([]);
  }
  const noRows = {
    async $queryRawUnsafe<T>() {
      return [] as T;
    },
  };
  await expect(financialProbeRules(noRows)[0]!.sample(now)).rejects.toThrow();
});

it("created退款有失败码严格超过一小时才报，重试重新计时、终态排除及原级别合并且采样零写", async () => {
  const h = await setup();
  const staff = await h.make.staff(),
    reviewer = await h.make.staff();
  async function refund(status: "created" | "processing" | "abnormal") {
    const now = h.clock.now(),
      order = await h.make.billingOrder(),
      approvalId = uuidv7(),
      requestId = uuidv7();
    await h.prisma.approvalRequest.create({
      data: {
        id: approvalId,
        requestNo: `TK${approvalId.replaceAll("-", "")}`,
        kind: "plan_refund",
        category: "approval",
        subjectType: "billing_order",
        subjectId: order.id,
        entityId: order.entityId,
        status: "approved",
        summarySnapshot: { title: "退款失败超时观测夹具" },
        requesterStaffId: staff.id,
        submitActorType: "staff",
        submitActorId: staff.id,
        submitClient: "admin",
        submittedAt: now,
        decidedAt: now,
        decidedByStaffId: reviewer.id,
        createdAt: now,
        updatedAt: now,
      },
    });
    await h.prisma.refundRequest.create({
      data: {
        id: requestId,
        approvalRequestId: approvalId,
        source: "customer_service",
        entityId: order.entityId,
        billingOrderId: order.id,
        paymentTxnId: order.paidPaymentTxnId!,
        baseAmountFen: order.amountFen,
        amountFen: order.amountFen,
        breakdownSnapshot: {},
        ruleCode: "window",
        ruleText: "测试退款",
        reasonCode: "other",
        status: "executing",
        execRoute: "wechat_original",
        executedByStaffId: reviewer.id,
        executedAt: now,
        execDueAt: now,
        slaSnapshot: {},
        createdAt: now,
        updatedAt: now,
      },
    });
    return h.prisma.refundTxn.create({
      data: {
        id: uuidv7(),
        entityId: order.entityId,
        refundRequestId: requestId,
        billingOrderId: order.id,
        paymentTxnId: order.paidPaymentTxnId!,
        channel: "wechat_jsapi",
        origin: "system",
        outRefundNo: uuidv7().replaceAll("-", ""),
        amountFen: order.amountFen,
        status,
        failCode: status === "created" ? "NOT_ENOUGH" : null,
        lastSubmitAt: new Date(
          now.getTime() - (status === "processing" ? 3 * 86_400_000 + 1 : 3_600_000),
        ),
        submitCount: 1,
        createdAt: new Date(now.getTime() - (status === "processing" ? 4 * 86_400_000 : 7_200_000)),
        updatedAt: now,
        lastQueriedAt: now,
      },
    });
  }
  const created = await refund("created");
  const update = (data: Parameters<typeof h.prisma.refundTxn.update>[0]["data"]) =>
    h.prisma.refundTxn.update({ where: { id: created.id }, data });
  const stuck = (processing = 0, abnormal = 0) => [
    {
      rule: "billing.refund_stuck",
      severity: abnormal > 0 ? "P1" : "P2",
      detail: { processing, abnormal, createdFailed: 1 },
    },
  ];
  expect(await h.sample()).toEqual([]); // 最近提交恰好一小时，旧创建时间不提前触发。
  h.clock.advance(1);
  expect(await h.sample()).toEqual(stuck());
  for (const failCode of [null, ""]) {
    await update({ failCode });
    expect(await h.sample()).toEqual([]);
  }
  await update({ failCode: "NOT_ENOUGH" });
  for (const status of ["closed", "not_accepted", "abandoned", "succeeded"]) {
    await update({ status, successAt: status === "succeeded" ? h.clock.now() : null });
    expect(await h.sample()).toEqual([]);
  }
  await update({
    status: "created",
    successAt: null,
    lastSubmitAt: h.clock.now(),
    submitCount: 2,
  });
  expect(await h.sample()).toEqual([]);
  h.clock.advance(3_600_000);
  expect(await h.sample()).toEqual([]);
  h.clock.advance(1);
  expect(await h.sample()).toEqual(stuck());
  expect(
    (await h.prisma.refundTxn.findUniqueOrThrow({ where: { id: created.id } })).outRefundNo,
  ).toBe(created.outRefundNo);
  await update({ lastSubmitAt: null, updatedAt: h.clock.now(), lastQueriedAt: h.clock.now() });
  expect(await h.sample()).toEqual(stuck()); // 缺提交时间回退创建；更新/查询不推迟告警。

  await refund("processing");
  expect(await h.sample()).toEqual(stuck(1));
  await refund("abnormal");
  const snapshot = () =>
    Promise.all([
      h.prisma.refundTxn.findMany({ orderBy: { id: "asc" } }),
      h.prisma.refundRequest.findMany({ orderBy: { id: "asc" } }),
      h.prisma.paymentTxn.findMany({ orderBy: { id: "asc" } }),
      h.prisma.billingOrder.findMany({ orderBy: { id: "asc" } }),
      h.prisma.approvalRequest.findMany({ orderBy: { id: "asc" } }),
      h.prisma.auditLog.count(),
      h.prisma.outboxEvent.count(),
      h.prisma.alertEvent.count(),
    ]);
  const before = await snapshot();
  expect(await h.sample()).toEqual(stuck(1, 1));
  expect(await snapshot()).toEqual(before);
});
