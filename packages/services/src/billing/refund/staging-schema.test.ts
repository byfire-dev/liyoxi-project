// 仅验证结构/读兼容；直接构造数据库反例，不装配系统退款写者或调用渠道。
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Prisma } from "@liyoxi/db";
import { createApprovalReads } from "../../approval/index.js";
import { uuidv7 } from "../../kernel/index.js";
import { snapshotTables, useSeededDatabase } from "../../testing/index.js";
import { createRefundHarness, refundIdem } from "./test.fixture.js";
import type { RefundHarness } from "./test.fixture.js";
import { refundInvariants } from "./invariants.js";
import { detail } from "./read.js";

const db = useSeededDatabase("services", { max: 1, label: "stgrfschema" });
let h: RefundHarness;
beforeEach(async () => {
  await db.reset();
  h = createRefundHarness(await db.prisma());
}, 60_000);
afterEach(() => h?.close());

async function fixture(approved = false) {
  const term = await h.make.subscriptionTerm({ priceTotalFen: 100 });
  const order = await h.prisma.billingOrder.findUniqueOrThrow({
    where: { id: term.sourceBillingOrderId },
  });
  const at = h.clock.now();
  const approval: Prisma.ApprovalRequestUncheckedCreateInput = {
    id: uuidv7(),
    requestNo: `TK${uuidv7()}`,
    kind: "staging_pay_refund",
    category: "approval",
    subjectType: "billing_order",
    subjectId: order.id,
    entityId: order.entityId,
    status: approved ? "approved" : "pending",
    summarySnapshot: { title: "预发系统退款结构样例", lines: [] },
    submitActorType: "system",
    submittedAt: at,
    ...(approved ? { decidedAt: at, isDecidedBySystem: true } : {}),
    createdAt: at,
    updatedAt: at,
  };
  await h.prisma.approvalRequest.create({ data: approval });
  const request: Prisma.RefundRequestUncheckedCreateInput = {
    id: uuidv7(),
    approvalRequestId: approval.id,
    source: "staging_probe",
    entityId: order.entityId,
    billingOrderId: order.id,
    paymentTxnId: order.paidPaymentTxnId!,
    baseAmountFen: 100,
    amountFen: 100,
    ruleCode: "window",
    ruleText: "窗口内原路退款",
    breakdownSnapshot: {
      v: 1,
      rule: "window",
      refundableFen: 100,
      termId: term.id,
      termStartsAt: term.startsAt.toISOString(),
      termEndsAt: term.endsAt.toISOString(),
      termStatus: term.status,
      windowDeadline: null,
      withinWindow: true,
      unused: true,
      upgraded: false,
      addonAvailable: 0,
      sideEffects: {
        revokePoints: 0,
        cancelSchedules: 0,
        addonWillSuspend: 0,
        nextTermWillStartNow: false,
      },
    },
    status: approved ? "pending_execution" : "pending_approval",
    ...(approved ? { execDueAt: at, slaSnapshot: {} } : {}),
    createdAt: at,
    updatedAt: at,
  };
  return { term, order, approval, request };
}
const i11 = (entityId: string) =>
  h.tx.run((tx) =>
    refundInvariants.find((r) => r.code === "payment.I11")!.run!(
      tx,
      { entityIds: [entityId] },
      { now: h.clock.now() },
    ),
  );
async function requestOf(data: Prisma.RefundRequestUncheckedCreateInput) {
  return h.prisma.refundRequest.create({ data });
}

it("系统审批仅接受真实system身份；pending不得预标决定，人工plan_refund仍必填员工", async () => {
  const { approval } = await fixture();
  const staff = await h.make.staff();
  const invalid: Partial<Prisma.ApprovalRequestUncheckedCreateInput>[] = [
    {
      submitActorType: "staff",
      submitActorId: staff.id,
      submitClient: "admin",
      requesterStaffId: staff.id,
    },
    { requesterStaffId: staff.id },
    { status: "approved", decidedAt: h.clock.now(), decidedByStaffId: staff.id },
    { isDecidedBySystem: true },
    { kind: "plan_refund" },
  ];
  for (const patch of invalid) {
    await expect(
      h.prisma.approvalRequest.create({
        data: {
          ...approval,
          ...patch,
          id: uuidv7(),
          requestNo: `TK${uuidv7()}`,
        },
      }),
    ).rejects.toThrow(/ck_approval_request_(staging_system|decision|submitter)/);
  }
  expect(await h.prisma.approvalRequest.count({ where: { kind: "staging_pay_refund" } })).toBe(1);
});

it("新来源仅window原路1..100分且未执行默认false，不接受冒标、员工或规则外路径", async () => {
  const { request } = await fixture();
  const staff = await h.make.staff();
  const invalid: Partial<Prisma.RefundRequestUncheckedCreateInput>[] = [
    { amountFen: 101, baseAmountFen: 101 },
    { amountFen: 0, baseAmountFen: 0 },
    { ruleCode: "qualification_failed" },
    { ruleCode: "override", isOverride: true },
    { execRoute: "offline" },
    { executedByStaffId: staff.id },
    { isExecutedBySystem: true },
    { isExecutedBySystem: true, executedAt: h.clock.now(), execRoute: "wechat_original" },
    { source: "customer_service", reasonCode: "legacy", isExecutedBySystem: true },
  ];
  for (const patch of invalid) {
    await expect(requestOf({ ...request, ...patch })).rejects.toThrow(/ck_refund_request_/);
  }
  expect(await requestOf(request)).toMatchObject({
    isExecutedBySystem: false,
    executedAt: null,
    executedByStaffId: null,
  });
});

it("系统执行必须原路、有实际时刻且不伪造执行员工；失败回待执行保留事实", async () => {
  const { request } = await fixture(true);
  for (const patch of [
    { status: "executing", execRoute: "wechat_original" },
    { isExecutedBySystem: true, executedAt: h.clock.now() },
    { executedAt: h.clock.now() },
  ]) {
    await expect(requestOf({ ...request, ...patch })).rejects.toThrow(/ck_refund_request_/);
  }
  const r = await requestOf({
    ...request,
    isExecutedBySystem: true,
    executedAt: h.clock.now(),
    execRoute: "wechat_original",
  });
  expect(r).toMatchObject({
    status: "pending_execution",
    isExecutedBySystem: true,
    executedByStaffId: null,
  });
});

it("I11精确匹配系统source/kind/主体，旧人工来源不能借系统kind", async () => {
  const f = await fixture();
  const row = await requestOf(f.request);
  expect(await i11(f.order.entityId)).toEqual([]);
  await h.prisma.refundRequest.update({
    where: { id: row.id },
    data: { source: "customer_service", reasonCode: "legacy" },
  });
  expect(await i11(f.order.entityId)).toMatchObject([
    { subject: { type: "refund_request", id: row.id }, entityId: f.order.entityId },
  ]);
  const staff = await h.make.staff();
  const manual = await h.prisma.approvalRequest.create({
    data: {
      ...f.approval,
      id: uuidv7(),
      requestNo: `TK${uuidv7()}`,
      kind: "plan_refund",
      submitActorType: "staff",
      submitActorId: staff.id,
      submitClient: "admin",
      requesterStaffId: staff.id,
    },
  });
  await h.prisma.refundRequest.update({
    where: { id: row.id },
    data: { approvalRequestId: manual.id },
  });
  expect(await i11(f.order.entityId)).toEqual([]);
  await h.prisma.refundRequest.update({
    where: { id: row.id },
    data: { source: "exception", reasonCode: null, ruleCode: "fulfillment_blocked" },
  });
  expect(await i11(f.order.entityId)).toEqual([]);
  await h.prisma.refundRequest.update({
    where: { id: row.id },
    data: { source: "staging_probe", ruleCode: "window" },
  });
  expect(await i11(f.order.entityId)).toHaveLength(1);
  await h.prisma.refundRequest.update({
    where: { id: row.id },
    data: { approvalRequestId: f.approval.id },
  });
  // 用真实另一单验证跨表配对，而非关闭FK。
  const other = await h.make.billingOrder({ entityId: f.order.entityId });
  await h.prisma.refundRequest.update({
    where: { id: row.id },
    data: { source: "staging_probe", reasonCode: null, billingOrderId: other.id },
  });
  expect(await i11(f.order.entityId)).toHaveLength(1);
});

it("I11不允许预标执行或借external退款；真实原路system意图允许保留失败事实", async () => {
  const f = await fixture(true);
  const r = await requestOf({
    ...f.request,
    isExecutedBySystem: true,
    executedAt: h.clock.now(),
    execRoute: "wechat_original",
  });
  expect(await i11(f.order.entityId)).toHaveLength(1);
  const txn = await h.prisma.refundTxn.create({
    data: {
      id: uuidv7(),
      entityId: r.entityId,
      billingOrderId: r.billingOrderId,
      paymentTxnId: r.paymentTxnId,
      refundRequestId: r.id,
      channel: "wechat_jsapi",
      origin: "external",
      outRefundNo: `lyxtest-${uuidv7()}`,
      amountFen: 100,
      status: "succeeded",
      successAt: h.clock.now(),
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  expect(await i11(f.order.entityId)).toHaveLength(1);
  await h.prisma.refundTxn.update({ where: { id: txn.id }, data: { origin: "system" } });
  expect(await i11(f.order.entityId)).toEqual([]);
  await h.prisma.refundRequest.update({
    where: { id: r.id },
    data: { isExecutedBySystem: false, executedAt: null },
  });
  expect(await i11(f.order.entityId)).toHaveLength(1);
});

it("新来源详情兼容真实审批读模型且全部人工动作关闭，GET零写", async () => {
  const actor = await h.staff("super_admin");
  // 只供读侧的元数据，未注册/执行任何系统退款处理器。
  const kinds = new Map(h.deps.approval!.kinds);
  kinds.set("staging_pay_refund", {
    ...kinds.get("plan_refund")!,
    operations: { get: null, approve: null, reject: null, withdraw: null },
  });
  const deps = {
    ...h.deps,
    approval: { ...h.deps.approval!, ...createApprovalReads({ kinds, clock: h.clock }) },
  };
  const tables = [
    "refund_request",
    "refund_txn",
    "approval_request",
    "audit_log",
    "outbox_event",
    "status_transition",
    "ledger_operation",
  ];
  for (const state of ["pending_approval", "pending_execution", "executing"] as const) {
    const f = await fixture(state !== "pending_approval");
    const executing = state === "executing";
    const r = await requestOf({
      ...f.request,
      ...(executing
        ? {
            status: state,
            isExecutedBySystem: true,
            executedAt: h.clock.now(),
            execRoute: "wechat_original",
          }
        : {}),
    });
    if (executing) {
      await h.prisma.refundTxn.create({
        data: {
          id: uuidv7(),
          entityId: r.entityId,
          billingOrderId: r.billingOrderId,
          paymentTxnId: r.paymentTxnId,
          refundRequestId: r.id,
          channel: "wechat_jsapi",
          origin: "system",
          outRefundNo: `lyxtest-${uuidv7()}`,
          amountFen: 100,
          status: "created",
          isRetryHalted: true,
          submitCount: 1,
          lastSubmitAt: h.clock.now(),
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      });
      h.clock.advance(600_001);
    }
    const before = await snapshotTables(h.prisma, tables);
    const view = await h.tx.run((tx) => detail(tx, deps, actor.staff, r.id));
    expect(view).toMatchObject({
      source: "staging_probe",
      executedBy: null,
      isExecutedBySystem: executing,
      allowedRoutes: [],
      canRetry: false,
      canConfirmNotAccepted: false,
      actions: [],
    });
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  }
});

it("旧人工来源仍默认false、同人审批/审批人执行被拒，另人执行保持原路径", async () => {
  const r = await h.request();
  await h.prisma.paramValue.create({
    data: {
      id: uuidv7(),
      key: "refund.require_distinct_executor",
      value: true,
      effectiveAt: h.clock.now(),
      createdByStaffId: r.approver.staff.staff.id,
      createdAt: h.clock.now(),
    },
  });
  const body = {
    lockVersion: 0,
    confirm: { requestNo: r.created.requestNo, amountFen: r.created.amountFen },
    confirmChecks: ["rule_amount_checked"],
  };
  await expect(
    h.service.approve(
      r.creator.ctx,
      r.creator.staff,
      r.created.refundRequestId,
      body,
      refundIdem(r.creator.ctx, "admin.refundRequest.approve", body),
    ),
  ).rejects.toMatchObject({ error: "APPROVAL_SELF_FORBIDDEN" });
  const approved = await h.service.approve(
    r.approver.ctx,
    r.approver.staff,
    r.created.refundRequestId,
    body,
    refundIdem(r.approver.ctx, "admin.refundRequest.approve", body),
  );
  expect(await h.service.get(r.executor.staff, r.created.refundRequestId)).toMatchObject({
    source: "customer_service",
    isExecutedBySystem: false,
  });
  const execute = h.executeBody({ ...r, approved });
  await expect(
    h.service.execute(
      r.approver.ctx,
      r.approver.staff,
      r.created.refundRequestId,
      execute,
      refundIdem(r.approver.ctx, "admin.refundRequest.execute", execute),
    ),
  ).rejects.toMatchObject({ error: "REFUND_EXECUTOR_CONFLICT" });
  await h.service.execute(
    r.executor.ctx,
    r.executor.staff,
    r.created.refundRequestId,
    execute,
    refundIdem(r.executor.ctx, "admin.refundRequest.execute", execute),
  );
  expect(await i11(r.entity.id)).toEqual([]);
});
