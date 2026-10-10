import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdPricingSnapshotSchema } from "@liyoxi/contract";
import type { AdCancelCoreSubmitBody } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { createPrismaClient } from "@liyoxi/db";
import { testDatabaseUrl } from "@liyoxi/db/testing/standalone";
import { createApproval } from "../approval/index.js";
import { ownTaskScope, SYSTEM_SCOPE } from "../authz/index.js";
import { createFlow } from "../flow/index.js";
import { createBizNoIssuer, createIdentityContext, lockRows, uuidv7 } from "../kernel/index.js";
import {
  createAdCancel,
  executeCancel,
  prelockAdCancelTargets,
  quoteAdCancel,
  readAdCancelTargetGraph,
  submitAdCancel,
  withdrawAdCancel,
} from "../order/index.js";
import type { Tx } from "../kernel/index.js";
import type { CancelActor, CancelDeps } from "../order/index.js";
import { createSla } from "../sla/index.js";
import { createTimers, timerKey } from "../timers/index.js";
import type { TimerRef } from "../timers/index.js";
import {
  assembleForTest,
  assertSnapshotsEqual,
  createFakeProviders,
  createLedgerHarness,
  holdDrama,
  joinLedger,
  openTerm,
  prepareOrderDrama,
  sampleStaffContext,
  snapshotTables,
  useSeededDatabase,
} from "../testing/index.js";
import { buildWorkerServices } from "./worker.js";

const db = useSeededDatabase("services", { label: "adcancel", max: 4 });
let h: ReturnType<typeof createLedgerHarness>;
let sequence = 0;
const ownedWorkers: ReturnType<typeof buildWorkerServices>[] = [];
const tables = [
  "billing_account",
  "point_lot",
  "point_hold",
  "point_hold_alloc",
  "ledger_operation",
  "point_ledger_entry",
  "approval_request",
  "cancel_request",
  "cancel_request_line",
  "ad",
  "outbox_event",
  "timer",
  "status_transition",
  "audit_log",
  "delivery_ticket_pause",
  "service_ticket_ref",
];
beforeAll(async () => {
  h = createLedgerHarness(await db.prisma());
}, 120_000);
afterAll(async () => {
  for (const worker of ownedWorkers.reverse()) {
    worker.closeApproval?.();
    await worker.shutdownMediaJobs?.();
    worker.closeMediaJobs?.();
    await worker.closeDocs();
    await worker.documentConverter?.close();
    await worker.closeNotify();
    await worker.closeAnalytics?.();
    await worker.closeStaff?.();
    await worker.closeSmsHealth?.();
    await worker.closeAlertFacts?.();
    worker.closeOrder?.();
    worker.closeBillingTimers?.();
    worker.closePublish?.();
    worker.closeDelivery?.();
    worker.closeWebhooks?.();
    await worker.closeMediaDrivers?.();
    await worker.closeStorageDrivers?.();
  }
});
function deps(overrides: Partial<CancelDeps> = {}): CancelDeps {
  const assembly = assembleForTest({ entry: "api" });
  const events = overrides.events ?? h.events;
  const flow = createFlow({ assembly, clock: h.clock, events });
  const timers = createTimers({ assembly }),
    sla = createSla({ assembly, clock: h.clock });
  const approval = createApproval({
    assembly,
    clock: h.clock,
    flow,
    events,
    timers,
    sla,
    bizNo: createBizNoIssuer({ clock: h.clock, appEnv: "test" }),
  });
  return {
    tx: h.tx,
    clock: h.clock,
    approval,
    flow,
    ledger: h.ledger,
    events,
    timers,
    sla,
    ...overrides,
  };
}
async function person(role: "super_admin" | "publisher" = "super_admin"): Promise<CancelActor> {
  const group = await h.prisma.staffGroup.findFirstOrThrow({
    where: { staffRoleKey: role, isDefault: true },
  });
  const row = await h.make.staff({ staffRoleKey: role, staffGroupId: group.id, isLead: true });
  return {
    ctx: createIdentityContext({ actor: { type: "staff", id: row.id, client: "admin" } }),
    staff: await sampleStaffContext(h.prisma, row.id, { stepUpAt: h.clock.now() }),
  };
}
async function fresh(actor: CancelActor): Promise<CancelActor> {
  return {
    ...actor,
    staff: await sampleStaffContext(h.prisma, actor.staff!.staff.id, { stepUpAt: h.clock.now() }),
  };
}
async function param(key: string, value: Prisma.InputJsonValue, staffId: string) {
  h.clock.advance(1);
  return h.prisma.paramValue.create({
    data: {
      id: uuidv7(),
      key,
      value,
      effectiveAt: h.clock.now(),
      createdAt: h.clock.now(),
      createdByStaffId: staffId,
      reason: "广告取消集成夹具",
    },
  });
}
async function billingParam(key: string, value: Prisma.InputJsonValue) {
  h.clock.advance(1);
  return h.prisma.billingParam.create({
    data: {
      id: uuidv7(),
      key,
      value,
      effectiveAt: h.clock.now(),
      changeId: uuidv7(),
      createdAt: h.clock.now(),
    },
  });
}
const ratios = (adInProduction: number) => ({
  planConfirm: 3000,
  adAndSample: 3000,
  samplePending: 5000,
  postSample: null,
  adInProduction,
});
type Reason = AdCancelCoreSubmitBody["reasonCode"];
async function fixture(
  options: { status?: string; returnedFrom?: string; ratioBp?: number; reasonCode?: Reason } = {},
) {
  h.clock.set(new Date(Date.parse("2026-01-05T04:00:00.000Z") + ++sequence * 60_000));
  const requester = await person(),
    approver = await person(),
    executor = await person();
  await param("refund.points.auto_approve_before_production", false, requester.staff!.staff.id);
  await param("refund.require_distinct_executor", false, requester.staff!.staff.id);
  await billingParam("cancelDeductionBp", ratios(options.ratioBp ?? 3000));
  await billingParam("expiredTermRefund", {
    merchant: "forfeit",
    platform: "addon",
    qualification: "addon",
  });
  const merchant = await h.make.merchant({ verified: true });
  const { term } = await openTerm(h, { entityId: merchant.entity.id });
  const id = uuidv7(),
    now = h.clock.now(),
    adNo = `GG20260105${String(sequence).padStart(5, "0")}`;
  const ctx = createIdentityContext({
    actor: { type: "system", job: "lyxtest.ad_fixture" },
    entityId: merchant.entity.id,
  });
  // M5 has no ad producer yet. Only this upstream ad fixture is inserted; all cancellation rows use the real service.
  const held = await h.tx.run((tx) =>
    h.ledger.hold(tx, {
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      refType: "ad",
      refId: id,
      pricing: { kind: "ad" },
      title: { code: "ad_hold", args: { adNo, unitPoints: 50, discountBp: term.discountBp } },
      ctx,
    }),
  );
  const pricing = AdPricingSnapshotSchema.parse(held.snapshot),
    status = options.status ?? "pending_assign";
  const captured =
    status !== "pending_assign" &&
    !(status === "returned" && options.returnedFrom === "pending_assign");
  if (captured)
    await h.tx.run((tx) =>
      h.ledger.capture(tx, {
        pointHoldId: held.pointHoldId,
        title: { refType: "ad", refNo: adNo, count: 1 },
        ctx,
      }),
    );
  const hold = await h.prisma.pointHold.findUniqueOrThrow({ where: { id: held.pointHoldId } });
  const editor = captured ? await h.make.staff({ staffRoleKey: "editor" }) : null;
  const consent = await h.make.agreementConsent({
    scene: "ad_request",
    merchantUserId: merchant.user.id,
    entityId: merchant.entity.id,
    storeId: merchant.store.id,
    bizId: id,
  });
  const ad = await h.prisma.ad.create({
    data: {
      id,
      adNo,
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      requestedByUserId: merchant.user.id,
      type: "opening",
      durationSec: 3,
      promoPointCodes: ["TEST"],
      status,
      returnedFrom: options.returnedFrom ?? null,
      ...(status === "returned" ? { returnedAt: now, returnReason: "商家补充素材" } : {}),
      ...(status === "confirmed"
        ? { confirmedAt: now, confirmedVersionNo: 1, latestVersionNo: 1 }
        : {}),
      ...(status === "pending_confirm" ? { latestVersionNo: 1 } : {}),
      unitPricePoints: pricing.unitPoints,
      discountBp: pricing.discountBp,
      chargePoints: held.points,
      pricingSnapshot: held.snapshot,
      pointHoldId: held.pointHoldId,
      capturedAt: hold.capturedAt,
      editorId: editor?.id ?? null,
      freeRevisionQuota: pricing.freeRevisions,
      agreementConsentId: consent.id,
      submittedAt: now,
      firstDueAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  const q = await h.tx.run((tx) =>
    quoteAdCancel(
      tx,
      {
        scope: SYSTEM_SCOPE,
        adId: ad.id,
        body: { reasonCode: options.reasonCode ?? "merchant_request" },
      },
      h.clock.now(),
    ),
  );
  const body: AdCancelCoreSubmitBody = {
    reasonCode: options.reasonCode ?? "merchant_request",
    note: "商家申请取消广告制作",
    expect: q.expect,
  };
  const d = deps();
  return {
    ad,
    merchant,
    term,
    requester,
    approver,
    executor,
    body,
    q,
    deps: d,
    service: createAdCancel(d),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function boundItem(f: Fixture) {
  const order = await h.make.dramaOrder({
    entityId: f.ad.entityId,
    storeId: f.ad.storeId,
    subscriptionTermId: f.term.id,
  });
  const drama = await prepareOrderDrama(h, 100);
  const held = await holdDrama(h, {
    entityId: f.ad.entityId,
    storeId: f.ad.storeId,
    dramaId: drama.id,
  });
  const item = await h.make.orderItem({
    id: held.refId,
    dramaOrderId: order.id,
    dramaId: drama.id,
    pointHoldId: held.pointHoldId,
    chargePoints: held.points,
    pricingSnapshot: held.snapshot,
  });
  return { order, item };
}
type Request = Awaited<ReturnType<ReturnType<typeof createAdCancel>["submit"]>>;
const submit = (f: Fixture) => f.service.submit(f.requester, f.ad.id, f.body);
const confirm = (r: Request) => ({
  requestNo: r.approvalRequest.requestNo!,
  totalRefundPoints: r.totalRefundPoints,
});
const approve = (f: Fixture, r: Request) =>
  f.service.approve(f.approver, r.id, {
    lockVersion: r.approvalRequest.lockVersion,
    confirm: confirm(r),
    confirmChecks: ["stage_rule_amount_checked"],
  });
const execute = (f: Fixture, r: Request) =>
  f.service.execute(f.executor, r.id, {
    confirm: confirm(r),
    confirmChecks: ["order_points_checked"],
  });
const req = (id: string) =>
  h.prisma.cancelRequest.findUniqueOrThrow({
    where: { id },
    include: { approvalRequest: true, cancelRequestLines: true },
  });
const adNow = (f: Fixture) => h.prisma.ad.findUniqueOrThrow({ where: { id: f.ad.id } });
const holdNow = (f: Fixture) =>
  h.prisma.pointHold.findUniqueOrThrow({ where: { id: f.ad.pointHoldId } });
async function observe(f: Fixture) {
  return {
    ad: await adNow(f),
    hold: await holdNow(f),
    account: await h.prisma.billingAccount.findUniqueOrThrow({
      where: { entityId: f.ad.entityId },
    }),
    lots: await h.prisma.pointLot.findMany({
      where: { entityId: f.ad.entityId },
      orderBy: { id: "asc" },
    }),
    operations: await h.prisma.ledgerOperation.findMany({
      where: { entityId: f.ad.entityId },
      orderBy: { id: "asc" },
    }),
    requests: await h.prisma.cancelRequest.findMany({
      where: { entityId: f.ad.entityId },
      orderBy: { id: "asc" },
      include: { approvalRequest: true, cancelRequestLines: true },
    }),
    events: await h.prisma.outboxEvent.findMany({
      where: { entityId: f.ad.entityId },
      orderBy: { id: "asc" },
    }),
    timers: await h.prisma.timer.findMany({
      where: { entityId: f.ad.entityId },
      orderBy: { id: "asc" },
    }),
    transitions: await h.prisma.statusTransition.findMany({
      where: { subjectId: f.ad.id },
      orderBy: { id: "asc" },
    }),
  };
}
async function historyRef(f: Fixture, r: Request) {
  const id = uuidv7(),
    now = h.clock.now();
  await h.prisma.serviceTicket.create({
    data: {
      id,
      ticketNo: `KF20260105${String(++sequence).padStart(5, "0")}`,
      entityId: f.ad.entityId,
      storeId: f.ad.storeId,
      source: "weapp",
      submitterUserId: f.merchant.user.id,
      typeCode: "K01",
      priority: "mid",
      description: "取消申请历史关联",
      status: "pending",
      solutionDueAt: new Date(now.getTime() + 86_400_000),
      slaSnapshot: { solution: {} },
      createdAt: now,
      updatedAt: now,
    },
  });
  return h.prisma.serviceTicketRef.create({
    data: {
      serviceTicketId: id,
      refType: "approval_request",
      refId: r.approvalRequestId,
      createdAt: now,
    },
  });
}
async function expectClosed(f: Fixture, r: Request, reason: "rejected" | "withdrawn" | "voided") {
  const row = await req(r.id);
  expect(row).toMatchObject({ status: "not_executed", closeReason: reason, executedAt: null });
  expect(row.closedAt).not.toBeNull();
  expect((await adNow(f)).openCancelRequestId).toBeNull();
  expect((await holdNow(f)).status).toBe(f.ad.capturedAt ? "captured" : "held");
  expect(
    await h.prisma.timer.count({
      where: {
        subjectId: r.approvalRequestId,
        status: { in: ["scheduled", "dispatched"] },
        kind: "sla.breach",
      },
    }),
  ).toBe(0);
  expect(
    await h.prisma.serviceTicketRef.count({
      where: { refType: "approval_request", refId: r.approvalRequestId },
    }),
  ).toBe(1);
}
async function afterExpiry(f: Fixture) {
  h.clock.set(new Date(f.term.endsAt.getTime() + 1));
  f.approver = await fresh(f.approver);
  f.executor = await fresh(f.executor);
}

it.each([
  ["pending_assign", undefined, "release", "09:808"],
  ["returned", "pending_assign", "release", "09:808"],
  ["producing", undefined, "refund", "09:809"],
  ["revising", undefined, "refund", "09:809"],
  ["pending_confirm", undefined, "refund", "09:809"],
  ["returned", "producing", "refund", "09:809"],
] as const)(
  "真实 %s/%s 经批准执行 %s，按正式行 %s 留痕",
  async (status, returnedFrom, mode, ref) => {
    const f = await fixture({ status, ...(returnedFrom ? { returnedFrom } : {}) });
    const selected: string[] = [],
      original = f.deps.flow;
    f.service = createAdCancel({
      ...f.deps,
      flow: {
        ...original,
        transition: async (...args: Parameters<typeof original.transition>) => {
          const result = await original.transition(...args);
          if (args[2].machine === "ad") selected.push(result.ref);
          return result;
        },
      },
    });
    const r = await submit(f);
    expect((await req(r.id)).cancelRequestLines[0]).toMatchObject({
      mode,
      targetType: "ad",
      targetId: f.ad.id,
    });
    const approved = await approve(f, r),
      out = await execute(f, approved),
      row = await req(r.id);
    expect(out.status).toBe("done");
    expect(row).toMatchObject({
      executedByStaffId: f.executor.staff!.staff.id,
      isExecutedBySystem: false,
      execConfirmChecks: ["order_points_checked"],
    });
    expect(row.executedAt).toEqual(row.closedAt);
    expect(row.cancelRequestLines[0]).toMatchObject({
      returnedPoints: r.totalRefundPoints,
      convertedPoints: 0,
      forfeitedPoints: 0,
    });
    expect(await adNow(f)).toMatchObject({
      status: "cancelled",
      openCancelRequestId: null,
      cancelReasonCode: "merchant_request",
      refundRequestedPoints: r.totalRefundPoints,
      returnedPoints: r.totalRefundPoints,
      convertedPoints: 0,
      forfeitedPoints: 0,
    });
    expect(
      await h.prisma.statusTransition.findFirst({
        where: { subjectId: f.ad.id, event: "ad.cancel" },
      }),
    ).toMatchObject({ fromState: status, toState: "cancelled" });
    expect(selected).toEqual([ref]);
    const event = await h.prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: "ad.cancelled", aggregateId: f.ad.id },
    });
    expect(event.payload).toMatchObject({
      returnedPoints: r.totalRefundPoints,
      forfeitedPoints: 0,
      fromState: status,
    });
  },
);

describe("真实广告取消写链", () => {
  it("提交产生真实审批、唯一明细和自有指针，广告状态与账本保持提交前事实", async () => {
    const f = await fixture(),
      before = await holdNow(f),
      r = await submit(f),
      row = await req(r.id);
    expect(row).toMatchObject({
      kind: "ad_cancel",
      status: "pending_approval",
      lineCount: 1,
      execDueAt: null,
      slaSnapshot: null,
    });
    expect(row.approvalRequest).toMatchObject({
      kind: "ad_cancel",
      category: "approval",
      subjectType: "ad",
      subjectId: f.ad.id,
      requesterStaffId: f.requester.staff!.staff.id,
      status: "pending",
      dedupeKey: null,
    });
    expect(row.approvalRequest.summarySnapshot).toMatchObject({
      points: r.totalRefundPoints,
      domain: { type: "cancel_request", id: r.id },
    });
    expect(await holdNow(f)).toEqual(before);
    expect(await adNow(f)).toMatchObject({ status: f.ad.status, openCancelRequestId: r.id });
    expect(await h.prisma.deliveryTicketPause.count()).toBe(0);
    expect(
      await h.prisma.outboxEvent.count({
        where: { eventType: "cancel.submitted", aggregateId: r.id },
      }),
    ).toBe(1);
  });
  it("原核算快照优先于提交之后的新扣除比例", async () => {
    const f = await fixture({ status: "producing" });
    await billingParam("cancelDeductionBp", ratios(10000));
    const r = await submit(f),
      row = await req(r.id);
    expect(row.cancelRequestLines[0]).toMatchObject({
      ratioBp: 3000,
      refundPoints: f.q.totalRefundPoints,
    });
    expect((await execute(f, await approve(f, r))).status).toBe("done");
  });
  it("平台原因生产中扣除为零，使用真实账本全额退款", async () => {
    const f = await fixture({ status: "producing", reasonCode: "platform_fault" }),
      r = await submit(f);
    expect((await req(r.id)).cancelRequestLines[0]).toMatchObject({
      reasonClass: "platform",
      ratioBp: 0,
      deductPoints: 0,
    });
    await execute(f, await approve(f, r));
    expect(await adNow(f)).toMatchObject({
      returnedPoints: f.ad.chargePoints,
      convertedPoints: 0,
      forfeitedPoints: 0,
    });
    const confirmed = await fixture({ status: "confirmed" });
    await expect(submit(confirmed)).rejects.toMatchObject({
      error: "AD_NOT_CANCELLABLE",
      details: { reason: "ad_confirmed" },
    });
  });
  it("100%扣除只终止，不产生虚假的账本退回操作", async () => {
    const f = await fixture({ status: "producing", ratioBp: 10000 }),
      r = await submit(f);
    const before = await h.prisma.ledgerOperation.count({ where: { entityId: f.ad.entityId } });
    await execute(f, await approve(f, r));
    expect((await req(r.id)).cancelRequestLines[0]).toMatchObject({
      mode: "terminate_only",
      returnedPoints: 0,
      convertedPoints: 0,
      forfeitedPoints: 0,
    });
    expect(await h.prisma.ledgerOperation.count({ where: { entityId: f.ad.entityId } })).toBe(
      before,
    );
    expect((await holdNow(f)).status).toBe("captured");
  });
  it("单独付费修改冻结单不进入本次广告取消也不被退回", async () => {
    const f = await fixture({ status: "producing", reasonCode: "platform_fault" });
    const extra = await h.tx.run((tx) =>
      h.ledger.charge(tx, {
        entityId: f.ad.entityId,
        storeId: f.ad.storeId,
        refType: "ad_revision",
        refId: uuidv7(),
        pricing: { kind: "ad_revision" },
        title: {
          code: "ad_revision_charge",
          args: { adNo: f.ad.adNo, unitPoints: 50, discountBp: f.term.discountBp },
        },
        captureTitle: { refType: "ad_revision", refNo: f.ad.adNo, count: 1 },
        ctx: f.requester.ctx,
      }),
    );
    const before = await h.prisma.pointHold.findUniqueOrThrow({ where: { id: extra.pointHoldId } });
    const r = await submit(f);
    await execute(f, await approve(f, r));
    expect(
      await h.prisma.pointHold.findUniqueOrThrow({ where: { id: extra.pointHoldId } }),
    ).toEqual(before);
    expect((await req(r.id)).cancelRequestLines).toHaveLength(1);
  });
  it("原周期结束后的商家原因，实际三数量按账本不予退回结果保存", async () => {
    const f = await fixture({ status: "producing" });
    await afterExpiry(f);
    const r = await submit(f);
    await execute(f, await approve(f, r));
    expect((await req(r.id)).cancelRequestLines[0]).toMatchObject({
      returnedPoints: 0,
      convertedPoints: 0,
      forfeitedPoints: r.totalRefundPoints,
    });
    expect(await adNow(f)).toMatchObject({
      refundRequestedPoints: r.totalRefundPoints,
      returnedPoints: 0,
      convertedPoints: 0,
      forfeitedPoints: r.totalRefundPoints,
    });
    expect((await holdNow(f)).forfeitedQty).toBe(r.totalRefundPoints);
  });
  it("原周期结束后的平台原因转加购，广告事件回传实际到账合计", async () => {
    const f = await fixture({ status: "producing", reasonCode: "platform_fault" });
    await afterExpiry(f);
    const r = await submit(f);
    await execute(f, await approve(f, r));
    expect((await req(r.id)).cancelRequestLines[0]).toMatchObject({
      returnedPoints: 0,
      convertedPoints: r.totalRefundPoints,
      forfeitedPoints: 0,
    });
    expect(await adNow(f)).toMatchObject({
      returnedPoints: 0,
      convertedPoints: r.totalRefundPoints,
      forfeitedPoints: 0,
    });
    expect(
      (
        await h.prisma.outboxEvent.findFirstOrThrow({
          where: { eventType: "ad.cancelled", aggregateId: f.ad.id },
        })
      ).payload,
    ).toMatchObject({ returnedPoints: r.totalRefundPoints, forfeitedPoints: 0 });
  });
  it("本人撤回关闭真实审批与本申请指针，保留历史客服引用", async () => {
    const f = await fixture(),
      r = await submit(f);
    await historyRef(f, r);
    await f.service.withdraw(f.requester, r.id, {});
    await expectClosed(f, r, "withdrawn");
    expect((await req(r.id)).approvalRequest.status).toBe("withdrawn");
    const next = await submit(f);
    await expect(f.service.withdraw(f.requester, r.id, {})).rejects.toMatchObject({
      error: "APPROVAL_NOT_PENDING",
    });
    expect((await adNow(f)).openCancelRequestId).toBe(next.id);
  });
  it("驳回跳过stepup并只解除本申请，保留历史引用", async () => {
    const f = await fixture(),
      r = await submit(f);
    await historyRef(f, r);
    const actor = { ...f.approver, staff: { ...f.approver.staff!, stepUpAt: null } };
    await f.service.reject(actor, r.id, { note: "规则核对不通过" });
    await expectClosed(f, r, "rejected");
    expect((await req(r.id)).approvalRequest).toMatchObject({
      status: "rejected",
      decisionNote: "规则核对不通过",
    });
  });
  it("本人作废保留approved审批，关闭执行timer与自有指针", async () => {
    const f = await fixture(),
      r = await submit(f);
    await historyRef(f, r);
    await approve(f, r);
    await f.service.void(f.requester, r.id, { note: "商家决定继续制作" });
    await expectClosed(f, r, "voided");
    expect((await req(r.id)).approvalRequest.status).toBe("approved");
  });
  it("发起人已停用时真实财务可代撤，审批记录代撤事实", async () => {
    const f = await fixture(),
      r = await submit(f);
    await historyRef(f, r);
    await h.prisma.staff.update({
      where: { id: f.requester.staff!.staff.id },
      data: {
        status: "disabled",
        disabledAt: h.clock.now(),
        disabledReason: "other",
        disabledByStaffId: f.approver.staff!.staff.id,
      },
    });
    await f.service.withdraw(f.approver, r.id, { note: "申请人已停用，代为撤回" });
    await expectClosed(f, r, "withdrawn");
    expect((await req(r.id)).approvalRequest).toMatchObject({
      status: "withdrawn",
      isDecidedBySystem: false,
      decidedByStaffId: null,
    });
  });
  it("真实系统入口不能撤回仍然有效的广告申请", async () => {
    const f = await fixture(),
      r = await submit(f),
      before = await observe(f);
    const system = {
      ctx: createIdentityContext({ actor: { type: "system", job: "entity.close" } }),
    };
    await expect(f.service.withdraw(system, r.id, {})).rejects.toMatchObject({
      error: "APPROVAL_WITHDRAW_FORBIDDEN",
    });
    expect(await observe(f)).toEqual(before);
  });
  it("主体失效后系统实际代撤，全部关闭结果同事务并保存引用", async () => {
    const f = await fixture(),
      r = await submit(f);
    await historyRef(f, r);
    await h.prisma.entity.update({
      where: { id: f.ad.entityId },
      data: { lifecycle: "closed", closedAt: h.clock.now() },
    });
    const system = {
      ctx: createIdentityContext({ actor: { type: "system", job: "entity.close" } }),
    };
    await f.service.withdraw(system, r.id, { note: "主体已关闭" });
    await expectClosed(f, r, "withdrawn");
    expect((await req(r.id)).approvalRequest.isDecidedBySystem).toBe(true);
  });
  it("没有提交权限的真实员工不能创建取消申请", async () => {
    const f = await fixture(),
      publisher = await person("publisher"),
      before = await observe(f);
    await expect(f.service.submit(publisher, f.ad.id, f.body)).rejects.toMatchObject({
      error: "PERMISSION_DENIED",
    });
    expect(await observe(f)).toEqual(before);
  });
  it("范围外和不存在均返回404，不泄露已有申请与广告", async () => {
    const f = await fixture(),
      r = await submit(f);
    const actor = {
      ...f.approver,
      staff: { ...f.approver.staff!, scope: ownTaskScope(f.approver.staff!.staff) },
    };
    for (const id of [f.ad.id, uuidv7()])
      await expect(f.service.submit(actor, id, f.body)).rejects.toMatchObject({
        error: "NOT_FOUND",
      });
    for (const id of [r.id, uuidv7()])
      await expect(
        f.service.approve(actor, id, {
          lockVersion: 0,
          confirm: confirm(r),
          confirmChecks: ["stage_rule_amount_checked"],
        }),
      ).rejects.toMatchObject({ error: "NOT_FOUND" });
  });
  it("审批先拒绝本人和已决定状态，再触达回显与复核", async () => {
    const f = await fixture(),
      r = await submit(f);
    const body = {
      lockVersion: 999,
      confirm: { ...confirm(r), requestNo: "wrong" },
      confirmChecks: ["stage_rule_amount_checked"] as ["stage_rule_amount_checked"],
    };
    await expect(f.service.approve(f.requester, r.id, body)).rejects.toMatchObject({
      error: "APPROVAL_SELF_FORBIDDEN",
    });
    await f.service.reject(f.approver, r.id, { note: "申请说明不充分" });
    await expect(f.service.approve(f.approver, r.id, body)).rejects.toMatchObject({
      error: "APPROVAL_NOT_PENDING",
    });
  });
  it("审批再验证过期先拒绝，未进入任何业务迁移", async () => {
    const f = await fixture(),
      r = await submit(f),
      before = await observe(f);
    const actor = {
      ...f.approver,
      staff: { ...f.approver.staff!, stepUpAt: new Date(h.clock.now().getTime() - 600_001) },
    };
    await expect(
      f.service.approve(actor, r.id, {
        lockVersion: 0,
        confirm: confirm(r),
        confirmChecks: ["stage_rule_amount_checked"],
      }),
    ).rejects.toMatchObject({ error: "STEP_UP_REQUIRED" });
    expect(await observe(f)).toEqual(before);
  });
  it("锁版本冲突不会批准或提前清空广告指针", async () => {
    const f = await fixture(),
      r = await submit(f),
      before = await observe(f);
    await expect(
      f.service.approve(f.approver, r.id, {
        lockVersion: r.approvalRequest.lockVersion + 1,
        confirm: confirm(r),
        confirmChecks: ["stage_rule_amount_checked"],
      }),
    ).rejects.toMatchObject({ error: "VERSION_CONFLICT" });
    expect(await observe(f)).toEqual(before);
  });
  it("审批与执行都要求库中当前单号和预计退回合计的回显", async () => {
    const f = await fixture(),
      r = await submit(f);
    await expect(
      f.service.approve(f.approver, r.id, {
        lockVersion: r.approvalRequest.lockVersion,
        confirm: { ...confirm(r), totalRefundPoints: r.totalRefundPoints + 1 },
        confirmChecks: ["stage_rule_amount_checked"],
      }),
    ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
    const a = await approve(f, r),
      before = await observe(f);
    await expect(
      f.service.execute(f.executor, r.id, {
        confirm: { ...confirm(a), requestNo: "TKwrong" },
        confirmChecks: ["order_points_checked"],
      }),
    ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
    expect(await observe(f)).toEqual(before);
  });
  it("驳回未知或停用的字典原因会回滚并保留pending", async () => {
    const f = await fixture(),
      r = await submit(f);
    await h.prisma.dictItem.create({
      data: {
        id: uuidv7(),
        dictTypeKey: "reject_reason",
        code: "W210DISABLED",
        name: "已停用测试原因",
        isEnabled: false,
        position: 999,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const before = await observe(f);
    for (const code of ["W210UNKNOWN", "W210DISABLED"])
      await expect(
        f.service.reject(f.approver, r.id, { note: "真实字典守卫", reasonCodes: [code] }),
      ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    expect(await observe(f)).toEqual(before);
  });
  it("执行权限和再验证均真实校验，pending_execution保持不变", async () => {
    const f = await fixture(),
      r = await approve(f, await submit(f)),
      publisher = await person("publisher"),
      before = await observe(f);
    await expect(
      f.service.execute(publisher, r.id, {
        confirm: confirm(r),
        confirmChecks: ["order_points_checked"],
      }),
    ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
    const actor = { ...f.executor, staff: { ...f.executor.staff!, stepUpAt: null } };
    await expect(
      f.service.execute(actor, r.id, {
        confirm: confirm(r),
        confirmChecks: ["order_points_checked"],
      }),
    ).rejects.toMatchObject({ error: "STEP_UP_REQUIRED" });
    expect(await observe(f)).toEqual(before);
  });
  it("职责分离开启时审批人不能执行，另一名真实员工可以执行", async () => {
    const f = await fixture(),
      r = await approve(f, await submit(f));
    await param("refund.require_distinct_executor", true, f.requester.staff!.staff.id);
    const before = await observe(f);
    await expect(
      f.service.execute(f.approver, r.id, {
        confirm: confirm(r),
        confirmChecks: ["order_points_checked"],
      }),
    ).rejects.toMatchObject({ error: "REFUND_EXECUTOR_CONFLICT" });
    expect(await observe(f)).toEqual(before);
    expect((await execute(f, r)).status).toBe("done");
  });
  it("试算零写入，错误expect返回真实新quote且不产生半申请", async () => {
    const f = await fixture(),
      before = await snapshotTables(h.prisma, tables);
    const q = await h.tx.run((tx) =>
      quoteAdCancel(
        tx,
        { scope: SYSTEM_SCOPE, adId: f.ad.id, body: { reasonCode: f.body.reasonCode } },
        h.clock.now(),
      ),
    );
    expect(q).toEqual(f.q);
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
    await expect(
      f.service.submit(f.requester, f.ad.id, {
        ...f.body,
        expect: { totalRefundPoints: q.totalRefundPoints + 1 },
      }),
    ).rejects.toMatchObject({
      error: "CANCEL_QUOTE_CHANGED",
      details: { quote: { totalRefundPoints: q.totalRefundPoints } },
    });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });
  it("活跃广告位绑定阻止取消，关闭订单项的历史绑定原样保留", async () => {
    const f = await fixture();
    const { item } = await boundItem(f);
    const placement = await h.prisma.orderItemPlacement.create({
      data: {
        id: uuidv7(),
        orderItemId: item.id,
        slot: "opening",
        adId: f.ad.id,
        durationSec: f.ad.durationSec,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    await expect(submit(f)).rejects.toMatchObject({
      error: "AD_NOT_CANCELLABLE",
      details: { reason: "ad_in_use", boundOrderItemIds: [item.id] },
    });
    await h.tx.run(async (tx) => {
      await lockRows(tx, "order_item", [item.id]);
      await h.ledger.release(tx, {
        pointHoldId: item.pointHoldId,
        reasonClass: "merchant",
        title: { refNo: f.ad.adNo, dramaTitles: [] },
        ctx: f.requester.ctx,
      });
      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          phase: "cancelled",
          cancelledAt: h.clock.now(),
          cancelReasonCode: "merchant_request",
        },
      });
    });
    const r = await submit(f);
    await execute(f, await approve(f, r));
    expect(
      await h.prisma.orderItemPlacement.findUniqueOrThrow({ where: { id: placement.id } }),
    ).toEqual(placement);
    await expect(submit(f)).rejects.toMatchObject({
      error: "AD_NOT_CANCELLABLE",
      details: { reason: "ad_cancelled" },
    });
  });
  it("审批复核跨期变化先回滚，再独立保存失败log，状态与积分不变", async () => {
    const f = await fixture({ status: "producing" }),
      r = await submit(f);
    await afterExpiry(f);
    const before = await observe(f);
    await expect(approve(f, r)).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
    const row = await req(r.id);
    expect(row).toMatchObject({
      status: "pending_approval",
      approvalRequest: { status: "pending" },
      recheckLog: { approve: { ok: false } },
    });
    expect(
      (row.recheckLog as { approve: { diffs: unknown[] } }).approve.diffs.length,
    ).toBeGreaterThan(0);
    const after = await observe(f);
    expect(after.hold).toEqual(before.hold);
    expect(after.account).toEqual(before.account);
    expect(after.events).toEqual(before.events);
    expect(after.ad).toEqual(before.ad);
  });
  it("执行复核跨期变化保存独立失败log并保留执行timer", async () => {
    const f = await fixture({ status: "producing" }),
      r = await approve(f, await submit(f));
    await afterExpiry(f);
    const before = await observe(f);
    await expect(execute(f, r)).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
    expect(await req(r.id)).toMatchObject({
      status: "pending_execution",
      approvalRequest: { status: "approved" },
      recheckLog: { execute: { ok: false } },
      executedAt: null,
    });
    const after = await observe(f);
    expect(after.hold).toEqual(before.hold);
    expect(after.account).toEqual(before.account);
    expect(after.events).toEqual(before.events);
    expect(after.timers).toEqual(before.timers);
  });
  it("原周期全额释放命中自动开关，真实系统审批与执行同事务完成", async () => {
    const f = await fixture();
    await param("refund.points.auto_approve_before_production", true, f.requester.staff!.staff.id);
    const r = await submit(f),
      row = await req(r.id);
    expect(row).toMatchObject({
      status: "done",
      isExecutedBySystem: true,
      executedByStaffId: null,
      approvalRequest: { status: "approved", isDecidedBySystem: true, decidedByStaffId: null },
    });
    expect(row.cancelRequestLines[0]).toMatchObject({
      returnedPoints: r.totalRefundPoints,
      convertedPoints: 0,
      forfeitedPoints: 0,
    });
    expect((await adNow(f)).status).toBe("cancelled");
    expect(
      (
        await h.prisma.outboxEvent.findFirstOrThrow({
          where: { eventType: "cancel.executed", aggregateId: r.id },
        })
      ).payload,
    ).toMatchObject({
      isAutoExecuted: true,
      fromState: "pending_approval",
      transition: "cancel.auto_execute",
    });
    expect(
      await h.prisma.outboxEvent.count({
        where: { eventType: "approval.executed", aggregateId: r.approvalRequestId },
      }),
    ).toBe(1);
  });
  it("生产中即使平台全额退回也不能命中自动释放", async () => {
    const f = await fixture({ status: "producing", reasonCode: "platform_fault" });
    await param("refund.points.auto_approve_before_production", true, f.requester.staff!.staff.id);
    const r = await submit(f);
    expect(r.status).toBe("pending_approval");
    expect((await req(r.id)).approvalRequest.status).toBe("pending");
    expect((await holdNow(f)).status).toBe("captured");
  });
  it.each(["merchant_request", "platform_fault"] as const)(
    "跨期%s释放产生不予退回或转加购时不能自动执行",
    async (reasonCode) => {
      const f = await fixture({ reasonCode });
      await param(
        "refund.points.auto_approve_before_production",
        true,
        f.requester.staff!.staff.id,
      );
      await afterExpiry(f);
      const r = await submit(f),
        row = await req(r.id);
      expect(row).toMatchObject({
        status: "pending_approval",
        approvalRequest: { status: "pending" },
      });
      expect(row.cancelRequestLines[0]!.previewSnapshot).toMatchObject(
        reasonCode === "merchant_request"
          ? { backToOriginal: 0, forfeited: r.totalRefundPoints }
          : { backToOriginal: 0, convertedToAddon: r.totalRefundPoints },
      );
    },
  );
  it("调用方未提交事务中可见完整取消申请，独立连接不可见且外层回滚全部撤销", async () => {
    const f = await fixture(),
      before = await snapshotTables(h.prisma, tables),
      peer = await joinLedger(h, await db.url());
    try {
      await expect(
        h.tx.run(async (tx) => {
          const r = await submitAdCancel(tx, f.deps, f.requester, f.ad.id, f.body);
          expect(await tx.cancelRequest.findUnique({ where: { id: r.id } })).not.toBeNull();
          expect(
            await tx.approvalRequest.findUnique({ where: { id: r.approvalRequestId } }),
          ).not.toBeNull();
          expect(await tx.cancelRequestLine.count({ where: { cancelRequestId: r.id } })).toBe(1);
          expect(await peer.prisma.cancelRequest.findUnique({ where: { id: r.id } })).toBeNull();
          expect(
            await peer.prisma.approvalRequest.findUnique({ where: { id: r.approvalRequestId } }),
          ).toBeNull();
          throw new Error("outer-submit-rollback");
        }),
      ).rejects.toThrow("outer-submit-rollback");
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
    } finally {
      await peer.close();
    }
  });
  it("执行账本后的外层失败回滚全部状态、数量、账本与事件", async () => {
    const f = await fixture({ status: "producing" }),
      r = await approve(f, await submit(f));
    const before = await snapshotTables(h.prisma, tables),
      peer = await joinLedger(h, await db.url());
    try {
      await expect(
        h.tx.run(async (tx) => {
          await executeCancel(tx, f.deps, f.executor, r.id, {
            confirm: confirm(r),
            confirmChecks: ["order_points_checked"],
          });
          expect((await tx.cancelRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(
            "done",
          );
          expect(
            (await peer.prisma.cancelRequest.findUniqueOrThrow({ where: { id: r.id } })).status,
          ).toBe("pending_execution");
          throw new Error("outer-execute-rollback");
        }),
      ).rejects.toThrow("outer-execute-rollback");
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
    } finally {
      await peer.close();
    }
  });
  it("真实ledger.release返回后故障回滚广告迁移及所有财务副作用", async () => {
    const f = await fixture(),
      r = await approve(f, await submit(f)),
      before = await snapshotTables(h.prisma, tables);
    const broken = createAdCancel(
      deps({
        ledger: {
          ...h.ledger,
          release: async (...args) => {
            await h.ledger.release(...args);
            throw new Error("after-real-ledger-release");
          },
        },
      }),
    );
    await expect(
      broken.execute(f.executor, r.id, {
        confirm: confirm(r),
        confirmChecks: ["order_points_checked"],
      }),
    ).rejects.toThrow("after-real-ledger-release");
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });
  it("实际ad.cancelled事件插入后故障回滚退款、指针与全部迁移", async () => {
    const f = await fixture({ status: "producing" }),
      r = await approve(f, await submit(f)),
      before = await snapshotTables(h.prisma, tables);
    const broken = createAdCancel(
      deps({
        events: {
          ...h.events,
          emit: async (...args) => {
            const result = await h.events.emit(...args);
            if (args[2].type === "ad.cancelled") throw new Error("after-real-ad-event");
            return result;
          },
        },
      }),
    );
    await expect(
      broken.execute(f.executor, r.id, {
        confirm: confirm(r),
        confirmChecks: ["order_points_checked"],
      }),
    ).rejects.toThrow("after-real-ad-event");
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });
  it("已完成执行串行重放不重复账本、审批执行或广告事件", async () => {
    const f = await fixture(),
      r = await approve(f, await submit(f));
    await execute(f, r);
    const before = await snapshotTables(h.prisma, tables);
    expect((await execute(f, r)).status).toBe("done");
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });
  it("只取消真实广告首版、修改与待补充timer，不影响其他广告", async () => {
    const f = await fixture({ status: "producing" }),
      other = await fixture(),
      ids: string[] = [];
    await h.tx.run(async (tx) => {
      await lockRows(tx, "ad", [f.ad.id, other.ad.id]);
      const timerCases: [string, string][] = [
        ["sla.breach", "first:0"],
        ["sla.breach", "rev:1"],
        ["ad.returned_stale", "0"],
      ];
      for (const [kind, purpose] of timerCases)
        ids.push(
          (
            await f.deps.timers.arm(tx, {
              kind,
              subject: { type: "ad", id: f.ad.id },
              key: timerKey(kind, { type: "ad", id: f.ad.id }, purpose),
              fireAt: new Date(h.clock.now().getTime() + 86_400_000),
            })
          ).id,
        );
      await f.deps.timers.arm(tx, {
        kind: "sla.breach",
        subject: { type: "ad", id: other.ad.id },
        key: timerKey("sla.breach", { type: "ad", id: other.ad.id }, "first:0"),
        fireAt: new Date(h.clock.now().getTime() + 86_400_000),
      });
    });
    const r = await submit(f);
    await execute(f, await approve(f, r));
    expect(
      (await h.prisma.timer.findMany({ where: { id: { in: ids } } })).every(
        (row) => row.status === "cancelled",
      ),
    ).toBe(true);
    expect(
      await h.prisma.timer.count({ where: { subjectId: other.ad.id, status: "scheduled" } }),
    ).toBe(1);
  });
  it("真实worker扫描执行SLA到点并发出唯一approval.sla_breached，重复投递无副作用", async () => {
    const f = await fixture(),
      r = await approve(f, await submit(f)),
      refs: TimerRef[] = [];
    const worker = buildWorkerServices({
      appEnv: "test",
      prisma: h.prisma,
      clock: h.clock,
      assembly: assembleForTest({ entry: "worker" }),
      providers: createFakeProviders({ clock: h.clock }),
      channel: {
        downForMs: () => 0,
        enqueue: async (_queue, _id, raw) => {
          if (
            typeof raw === "object" &&
            raw !== null &&
            "timerId" in raw &&
            "dispatchNo" in raw &&
            "kind" in raw &&
            typeof raw.timerId === "string" &&
            typeof raw.dispatchNo === "number" &&
            typeof raw.kind === "string"
          )
            refs.push({ timerId: raw.timerId, dispatchNo: raw.dispatchNo, kind: raw.kind });
        },
      },
    });
    ownedWorkers.push(worker);
    const timer = await h.prisma.timer.findFirstOrThrow({
      where: {
        subjectId: r.approvalRequestId,
        dedupeKey: timerKey(
          "sla.breach",
          { type: "approval_request", id: r.approvalRequestId },
          "execution",
        ),
      },
    });
    expect(r.execDueAt!.getTime() - h.clock.now().getTime()).toBeGreaterThan(8 * 3_600_000);
    expect(timer.fireAt).toEqual(r.execDueAt);
    expect((await req(r.id)).slaSnapshot).toMatchObject({
      policy: "review.refund_execute",
      amount: 1,
      unit: "work_days",
    });
    h.clock.set(new Date(r.execDueAt!.getTime() + 1));
    await worker.scan({ limit: 200 });
    const ref = refs.find((one) => one.timerId === timer.id);
    expect(ref).toBeDefined();
    expect(await worker.runTimer(ref!)).toBe("fired");
    expect(await worker.runTimer(ref!)).toBe("stale");
    const breached = await h.prisma.outboxEvent.findMany({
      where: { eventType: "approval.sla_breached", aggregateId: r.approvalRequestId },
    });
    expect(breached).toHaveLength(1);
    expect(breached[0]!.payload).toMatchObject({ purpose: "execution", kind: "ad_cancel" });
    expect((await req(r.id)).status).toBe("pending_execution");
    expect((await adNow(f)).status).toBe("pending_assign");
  });
});

describe("广告取消两连接竞态与真实锁图", { timeout: 60000 }, () => {
  it("二十轮同广告并发申请只有一套审批、明细与指针", async () => {
    for (let round = 0; round < 20; round++) {
      const f = await fixture();
      const results = await Promise.allSettled([submit(f), submit(f)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({
        reason: { error: "AD_CANCEL_IN_PROGRESS" },
      });
      const rows = await h.prisma.cancelRequest.findMany({ where: { adId: f.ad.id } });
      expect(rows).toHaveLength(1);
      expect((await adNow(f)).openCancelRequestId).toBe(rows[0]!.id);
      expect(
        await h.prisma.cancelRequestLine.count({ where: { cancelRequestId: rows[0]!.id } }),
      ).toBe(1);
      expect(await h.prisma.approvalRequest.count({ where: { subjectId: f.ad.id } })).toBe(1);
      expect(
        await h.prisma.outboxEvent.count({
          where: { aggregateId: rows[0]!.id, eventType: "cancel.submitted" },
        }),
      ).toBe(1);
    }
  });
  it("二十轮批准与本人撤回竞争，审批和业务收尾保持同一结果", async () => {
    for (let round = 0; round < 20; round++) {
      const f = await fixture(),
        r = await submit(f);
      const results = await Promise.allSettled([
        approve(f, r),
        f.service.withdraw(f.requester, r.id, { note: "本人撤回" }),
      ]);
      expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
      expect(results.find((value) => value.status === "rejected")).toMatchObject({
        reason: { error: "APPROVAL_NOT_PENDING" },
      });
      const row = await req(r.id);
      if (row.approvalRequest.status === "withdrawn") {
        expect(row).toMatchObject({ status: "not_executed", closeReason: "withdrawn" });
        expect((await adNow(f)).openCancelRequestId).toBeNull();
      } else {
        expect(row).toMatchObject({
          status: "pending_execution",
          closeReason: null,
          approvalRequest: { status: "approved" },
        });
        expect((await adNow(f)).openCancelRequestId).toBe(r.id);
      }
      expect((await holdNow(f)).status).toBe("held");
    }
  });
  it("二十轮执行与作废竞争，只有真实执行能改积分和广告状态", async () => {
    for (let round = 0; round < 20; round++) {
      const f = await fixture(),
        r = await approve(f, await submit(f));
      const results = await Promise.allSettled([
        execute(f, r),
        f.service.void(f.requester, r.id, { note: "本人放弃本次退款" }),
      ]);
      expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
      expect(results.find((value) => value.status === "rejected")).toMatchObject({
        reason: { error: "STATE_NOT_ALLOWED" },
      });
      const row = await req(r.id),
        ad = await adNow(f),
        hold = await holdNow(f);
      expect(row.approvalRequest.status).toBe("approved");
      expect(ad.openCancelRequestId).toBeNull();
      if (row.status === "done") {
        expect(ad.status).toBe("cancelled");
        expect(hold.status).toBe("released");
        expect(ad.refundRequestedPoints).toBe(r.totalRefundPoints);
      } else {
        expect(row).toMatchObject({
          status: "not_executed",
          closeReason: "voided",
          executedAt: null,
        });
        expect(ad.status).toBe("pending_assign");
        expect(hold.status).toBe("held");
        expect(ad.refundRequestedPoints).toBe(0);
      }
    }
  });
  it("二十轮并发执行序列化重放，账本与执行事件都只产生一次", async () => {
    for (let round = 0; round < 20; round++) {
      const f = await fixture(),
        r = await approve(f, await submit(f));
      const result = await Promise.all([execute(f, r), execute(f, r)]);
      expect(result.map((one) => one.status)).toEqual(["done", "done"]);
      const ad = await adNow(f);
      expect(ad.refundRequestedPoints).toBe(r.totalRefundPoints);
      expect(ad.returnedPoints).toBe(r.totalRefundPoints);
      expect(
        await h.prisma.ledgerOperation.count({
          where: { entityId: f.ad.entityId, opType: "release" },
        }),
      ).toBe(1);
      for (const [eventType, aggregateId] of [
        ["cancel.executed", r.id],
        ["ad.cancelled", f.ad.id],
        ["approval.executed", r.approvalRequestId],
      ])
        expect(
          await h.prisma.outboxEvent.count({
            where: { eventType: eventType!, aggregateId: aggregateId! },
          }),
        ).toBe(1);
      expect(
        await h.prisma.statusTransition.count({
          where: { subjectId: r.id, event: "cancel.execute" },
        }),
      ).toBe(1);
    }
  });
  it("实际审批行锁阻塞真实批准调用，管理员observer核实际双方PID与阻塞对象", async () => {
    const f = await fixture(),
      r = await submit(f);
    let writerPid = 0,
      waiterPid = 0,
      locked!: () => void,
      release!: () => void,
      entered!: () => void;
    const held = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connected = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const writer = h.tx.run(async (tx) => {
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      writerPid = backend!.pid;
      await lockRows(tx, "approval_request", [r.approvalRequestId]);
      expect(
        (await tx.approvalRequest.findUniqueOrThrow({ where: { id: r.approvalRequestId } }))
          .subjectId,
      ).toBe(f.ad.id);
      locked();
      await proceed;
    });
    await held;
    const d = deps({
      tx: {
        ...h.tx,
        run: (fn, options) =>
          h.tx.run(async (tx) => {
            const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            waiterPid = backend!.pid;
            entered();
            return fn(tx);
          }, options),
      },
    });
    const waiter = createAdCancel(d)
      .approve(f.approver, r.id, {
        lockVersion: r.approvalRequest.lockVersion,
        confirm: confirm(r),
        confirmChecks: ["stage_rule_amount_checked"],
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    const observer = createPrismaClient({
      connectionString: testDatabaseUrl(db.name, { role: null }),
      max: 1,
    });
    try {
      await connected;
      expect(writerPid).toBeGreaterThan(0);
      expect(waiterPid).not.toBe(writerPid);
      let blocked = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const [backend] = await observer.$queryRaw<
          { waiting: boolean; blockers: number[]; query: string }[]
        >`
          SELECT wait_event_type = 'Lock' AS waiting, pg_blocking_pids(pid) AS blockers, query
          FROM pg_stat_activity WHERE pid = ${waiterPid}`;
        if (backend?.waiting) {
          expect(backend.blockers).toContain(writerPid);
          expect(backend.query).toContain('FROM "approval_request"');
          console.warn("ad cancel approval prelock observed", {
            writerPid,
            waiterPid,
            approvalId: r.approvalRequestId,
            adId: f.ad.id,
            blockers: backend.blockers,
          });
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      release();
      await writer;
      expect(await waiter).toMatchObject({ value: { status: "pending_execution" } });
    } finally {
      release();
      await writer;
      await waiter;
      await observer.$disconnect();
    }
  });
  it("读图后真实新增绑定，整体预锁后拒绝旧图并回滚而不补低序锁", async () => {
    const f = await fixture(),
      r = await submit(f);
    const { order, item } = await boundItem(f);
    let read!: () => void, proceed!: () => void;
    const readDone = new Promise<void>((resolve) => {
      read = resolve;
    });
    const changed = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const waiter = h.tx
      .run(async (tx) => {
        const graph = await readAdCancelTargetGraph(tx, [r.id]);
        expect(graph.itemIds).toEqual([]);
        read();
        await changed;
        await prelockAdCancelTargets(tx, graph);
      })
      .then(
        () => ({ ok: true }),
        (error: unknown) => ({ error }),
      );
    try {
      await readDone;
      // Only the existing M5 binding fixture is inserted; this does not claim an absent M5 producer.
      await h.tx.run(async (tx) => {
        await lockRows(tx, "ad", [f.ad.id]);
        await lockRows(tx, "drama_order", [order.id]);
        await lockRows(tx, "order_item", [item.id]);
        await tx.orderItemPlacement.create({
          data: {
            id: uuidv7(),
            orderItemId: item.id,
            slot: "opening",
            adId: f.ad.id,
            durationSec: f.ad.durationSec,
            createdAt: h.clock.now(),
            updatedAt: h.clock.now(),
          },
        });
      });
      proceed();
      expect(await waiter).toMatchObject({ error: { error: "PRECONDITION_CHANGED" } });
      expect((await req(r.id)).status).toBe("pending_approval");
      expect((await adNow(f)).openCancelRequestId).toBe(r.id);
      expect((await holdNow(f)).status).toBe("held");
      expect(
        await h.prisma.orderItemPlacement.count({ where: { adId: f.ad.id, orderItemId: item.id } }),
      ).toBe(1);
    } finally {
      proceed();
      await waiter;
    }
  });
});

// M5 producer is still absent: these are explicit legal upstream row fixtures, not ad.confirm/ad.cancel implementations.
async function terminalAd(
  f: Fixture,
  status: "confirmed" | "cancelled",
  client: Pick<Tx, "ad"> = h.prisma,
) {
  return client.ad.update({
    where: { id: f.ad.id },
    data: {
      status,
      openCancelRequestId: null,
      ...(status === "confirmed"
        ? { confirmedAt: h.clock.now(), confirmedVersionNo: 1 }
        : { cancelledAt: h.clock.now(), cancelReasonCode: "merchant_request" }),
    },
  });
}
async function invalidProxyFixture(status: "confirmed" | "cancelled" = "confirmed") {
  const f = await fixture({ status: "pending_confirm" }),
    r = await submit(f);
  await terminalAd(f, status);
  return { f, r };
}

describe("活跃发起人对象失效后的真实财务代撤", () => {
  it.each(["confirmed", "cancelled"] as const)(
    "%s终局+合法null指针保真实财务审计与所有积分数量",
    async (status) => {
      const { f, r } = await invalidProxyFixture(status);
      await historyRef(f, r);
      const before = await observe(f);
      const result = await f.service.withdraw(f.approver, r.id, { note: "对象已失效，财务代撤" });
      expect(result.status).toBe("not_executed");
      await expectClosed(f, r, "withdrawn");
      const row = await req(r.id),
        after = await observe(f);
      expect(row.approvalRequest).toMatchObject({
        status: "withdrawn",
        decidedByStaffId: null,
        isDecidedBySystem: false,
        decisionNote: "对象已失效，财务代撤",
      });
      expect(
        (await h.prisma.staff.findUniqueOrThrow({ where: { id: f.requester.staff!.staff.id } }))
          .status,
      ).toBe("active");
      expect(after.ad).toEqual(before.ad);
      for (const key of ["hold", "account", "lots", "operations"] as const)
        expect(after[key]).toEqual(before[key]);
      const audit = await h.prisma.auditLog.findFirstOrThrow({
        where: { targetId: r.approvalRequestId, action: "approval.request.withdraw" },
      });
      expect(audit).toMatchObject({
        actorType: "staff",
        actorId: f.approver.staff!.staff.id,
        client: "admin",
      });
      expect(audit.summary).toContain("代为撤回");
      for (const [eventType, aggregateId] of [
        ["approval.withdrawn", r.approvalRequestId],
        ["cancel.withdrawn", r.id],
      ] as const)
        expect(await h.prisma.outboxEvent.count({ where: { eventType, aggregateId } })).toBe(1);
      expect(
        await h.prisma.statusTransition.count({
          where: { subjectId: r.id, event: "approval.withdrawn" },
        }),
      ).toBe(1);
      await expect(f.service.withdraw(f.approver, r.id, {})).rejects.toMatchObject({
        error: "APPROVAL_NOT_PENDING",
      });
    },
  );
  it("仍有效广告拒绝代撤，行、timer、账本及事件零变化", async () => {
    const f = await fixture({ status: "pending_confirm" }),
      r = await submit(f),
      before = await snapshotTables(h.prisma, tables);
    await expect(f.service.withdraw(f.approver, r.id, {})).rejects.toMatchObject({
      error: "APPROVAL_WITHDRAW_FORBIDDEN",
    });
    await assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });
  it.each(["entity", "store"] as const)(
    "仅%s生命周期失效不能冒充广告终局财务代撤",
    async (target) => {
      const f = await fixture(),
        r = await submit(f);
      if (target === "entity")
        await h.prisma.entity.update({
          where: { id: f.ad.entityId },
          data: { lifecycle: "closed", closedAt: h.clock.now() },
        });
      else
        await h.prisma.store.update({
          where: { id: f.ad.storeId },
          data: {
            lifecycle: "archived",
            archivedAt: h.clock.now(),
            archiveActorType: "staff",
            archiveActorId: f.approver.id,
            archiveClient: "admin",
            archiveReason: "by_owner",
          },
        });
      const before = await snapshotTables(h.prisma, tables);
      await expect(f.service.withdraw(f.approver, r.id, {})).rejects.toMatchObject({
        error: "APPROVAL_WITHDRAW_FORBIDDEN",
      });
      await assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
    },
  );
  it("没有决定权限的真实员工不能代撤终局对象", async () => {
    const { f, r } = await invalidProxyFixture(),
      actor = await person("publisher"),
      before = await observe(f);
    await expect(f.service.withdraw(actor, r.id, {})).rejects.toMatchObject({
      error: "APPROVAL_WITHDRAW_FORBIDDEN",
    });
    expect(await observe(f)).toEqual(before);
  });
  it("范围外财务仍404且没有任何写入", async () => {
    const { f, r } = await invalidProxyFixture();
    const actor = {
      ...f.approver,
      staff: { ...f.approver.staff!, scope: ownTaskScope(f.approver.staff!.staff) },
    };
    const before = await snapshotTables(h.prisma, tables);
    await expect(f.service.withdraw(actor, r.id, {})).rejects.toMatchObject({ error: "NOT_FOUND" });
    await assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });
  it("实际已禁用操作员工即使旧上下文有权限也不能代撤", async () => {
    const { f, r } = await invalidProxyFixture();
    await h.prisma.staff.update({
      where: { id: f.approver.staff!.staff.id },
      data: {
        status: "disabled",
        disabledAt: h.clock.now(),
        disabledReason: "other",
        disabledByStaffId: f.requester.staff!.staff.id,
      },
    });
    const before = await observe(f);
    await expect(f.service.withdraw(f.approver, r.id, {})).rejects.toMatchObject({
      error: "PERMISSION_DENIED",
    });
    expect(await observe(f)).toEqual(before);
  });
  it("代撤再验证过期在原owner公口拒绝，不能享用C86驳回豁免", async () => {
    const { f, r } = await invalidProxyFixture();
    const actor = {
      ...f.approver,
      staff: { ...f.approver.staff!, stepUpAt: new Date(h.clock.now().getTime() - 600_001) },
    };
    const before = await observe(f);
    await expect(f.service.withdraw(actor, r.id, {})).rejects.toMatchObject({
      error: "STEP_UP_REQUIRED",
    });
    expect(await observe(f)).toEqual(before);
  });
  it("直接泛approval无真实owner上下文严格拒绝，不接受伪造invalid参数", async () => {
    const { f, r } = await invalidProxyFixture(),
      before = await snapshotTables(h.prisma, tables);
    expect(f.deps.approval.kinds.get("ad_cancel")?.isSubjectInvalidForWithdrawal).toBeTypeOf(
      "function",
    );
    await expect(
      h.tx.run((tx) =>
        f.deps.approval.withdraw(tx, f.approver.ctx, {
          approvalId: r.approvalRequestId,
          staff: f.approver.staff,
          args: { invalid: true },
        }),
      ),
    ).rejects.toMatchObject({ error: "INTERNAL" });
    await assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });
  it("只有真实预锁而无owner调用上下文仍拒绝", async () => {
    const { f, r } = await invalidProxyFixture(),
      before = await observe(f);
    await expect(
      h.tx.run(async (tx) => {
        await prelockAdCancelTargets(tx, await readAdCancelTargetGraph(tx, [r.id]), [
          f.approver.staff!.staff.id,
        ]);
        return f.deps.approval.withdraw(tx, f.approver.ctx, {
          approvalId: r.approvalRequestId,
          staff: f.approver.staff,
        });
      }),
    ).rejects.toMatchObject({ error: "INTERNAL" });
    expect(await observe(f)).toEqual(before);
  });
  it("已通过申请仍走原非pending拒绝，不因之后对象失效代撤", async () => {
    const f = await fixture({ status: "pending_confirm" }),
      r = await approve(f, await submit(f));
    await terminalAd(f, "confirmed");
    const before = await observe(f);
    await expect(f.service.withdraw(f.approver, r.id, {})).rejects.toMatchObject({
      error: "APPROVAL_NOT_PENDING",
    });
    expect(await observe(f)).toEqual(before);
  });
  it("终局null指针本人路径保持原拒绝，不借财务代撤条件放宽", async () => {
    const { f, r } = await invalidProxyFixture(),
      before = await observe(f);
    await expect(f.service.withdraw(f.requester, r.id, {})).rejects.toMatchObject({
      error: "PRECONDITION_CHANGED",
    });
    expect(await observe(f)).toEqual(before);
  });
  it("合法有效广告外来指针仍拒绝关闭，即使发起人已停用", async () => {
    const f = await fixture(),
      r = await submit(f),
      other = await fixture(),
      otherRequest = await submit(other);
    await h.prisma.ad.update({
      where: { id: f.ad.id },
      data: { openCancelRequestId: otherRequest.id },
    });
    await h.prisma.staff.update({
      where: { id: f.requester.staff!.staff.id },
      data: {
        status: "disabled",
        disabledAt: h.clock.now(),
        disabledReason: "other",
        disabledByStaffId: f.approver.staff!.staff.id,
      },
    });
    f.approver = await fresh(f.approver);
    const before = await snapshotTables(h.prisma, tables);
    await expect(f.service.withdraw(f.approver, r.id, {})).rejects.toMatchObject({
      error: "PRECONDITION_CHANGED",
    });
    await assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });
  it("同Tx真实代撤未提交对独立连接不可见，外层失败完整回滚", async () => {
    const { f, r } = await invalidProxyFixture(),
      before = await snapshotTables(h.prisma, tables),
      peer = await joinLedger(h, await db.url());
    try {
      await expect(
        h.tx.run(async (tx) => {
          const result = await withdrawAdCancel(tx, f.deps, f.approver, r.id, {
            note: "财务代撤待外层提交",
          });
          expect(result.status).toBe("not_executed");
          expect(
            (await tx.approvalRequest.findUniqueOrThrow({ where: { id: r.approvalRequestId } }))
              .status,
          ).toBe("withdrawn");
          expect(
            (
              await peer.prisma.approvalRequest.findUniqueOrThrow({
                where: { id: r.approvalRequestId },
              })
            ).status,
          ).toBe("pending");
          expect(
            (await peer.prisma.cancelRequest.findUniqueOrThrow({ where: { id: r.id } })).status,
          ).toBe("pending_approval");
          throw new Error("proxy-outer-rollback");
        }),
      ).rejects.toThrow("proxy-outer-rollback");
      await assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
    } finally {
      await peer.close();
    }
  });
  it("真实撤回事件插入后故障回滚审批、关闭、timer、审计与outbox", async () => {
    const { f, r } = await invalidProxyFixture(),
      before = await snapshotTables(h.prisma, tables);
    const events = {
      ...f.deps.events,
      emit: async (...args: Parameters<typeof f.deps.events.emit>) => {
        const result = await f.deps.events.emit(...args);
        if (args[2].type === "cancel.withdrawn") throw new Error("after-real-proxy-event");
        return result;
      },
    };
    f.service = createAdCancel(deps({ events }));
    await expect(f.service.withdraw(f.approver, r.id, {})).rejects.toThrow(
      "after-real-proxy-event",
    );
    await assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });
  it("只取消本审批决定timer，其他审批与广告timer保持原行", async () => {
    const { f, r } = await invalidProxyFixture(),
      other = await fixture(),
      otherRequest = await submit(other);
    f.approver = await fresh(f.approver);
    const before = await h.prisma.timer.findMany({
      where: { subjectId: { in: [f.ad.id, other.ad.id, otherRequest.approvalRequestId] } },
      orderBy: { id: "asc" },
    });
    expect(
      await h.prisma.timer.count({
        where: { subjectId: r.approvalRequestId, status: "scheduled" },
      }),
    ).toBe(1);
    await f.service.withdraw(f.approver, r.id, {});
    expect(
      await h.prisma.timer.findMany({
        where: { subjectId: { in: [f.ad.id, other.ad.id, otherRequest.approvalRequestId] } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
    expect(
      await h.prisma.timer.count({
        where: { subjectId: r.approvalRequestId, status: { in: ["scheduled", "dispatched"] } },
      }),
    ).toBe(0);
  });
  it("二十轮财务代撤与批准竞争，唯一关闭结果且积分不动", async () => {
    for (let round = 0; round < 20; round++) {
      const { f, r } = await invalidProxyFixture(),
        before = await holdNow(f);
      const outcomes = await Promise.allSettled([
        f.service.withdraw(f.approver, r.id, {}),
        approve(f, r),
      ]);
      expect(outcomes[0]).toMatchObject({ status: "fulfilled", value: { status: "not_executed" } });
      expect(outcomes[1].status).toBe("rejected");
      if (outcomes[1].status === "rejected")
        expect(["APPROVAL_NOT_PENDING", "PRECONDITION_CHANGED"]).toContain(
          outcomes[1].reason.error,
        );
      expect(await req(r.id)).toMatchObject({
        status: "not_executed",
        closeReason: "withdrawn",
        approvalRequest: { status: "withdrawn", isDecidedBySystem: false },
      });
      expect(await holdNow(f)).toEqual(before);
      expect(
        await h.prisma.outboxEvent.count({
          where: { eventType: "approval.withdrawn", aggregateId: r.approvalRequestId },
        }),
      ).toBe(1);
      expect(
        await h.prisma.outboxEvent.count({
          where: { eventType: "cancel.withdrawn", aggregateId: r.id },
        }),
      ).toBe(1);
    }
  });
  it("真实广告锁等待后按提交后的终局重读，核精确双方PID阻塞", async () => {
    const f = await fixture({ status: "pending_confirm" }),
      r = await submit(f);
    let writerPid = 0,
      waiterPid = 0,
      locked!: () => void,
      release!: () => void,
      entered!: () => void;
    const held = new Promise<void>((resolve) => {
        locked = resolve;
      }),
      proceed = new Promise<void>((resolve) => {
        release = resolve;
      }),
      connected = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const writer = h.tx.run(async (tx) => {
      writerPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      await lockRows(tx, "ad", [f.ad.id]);
      locked();
      await proceed;
      await terminalAd(f, "confirmed", tx);
    });
    await held;
    const d = deps({
      tx: {
        ...h.tx,
        run: (fn, options) =>
          h.tx.run(async (tx) => {
            waiterPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!
              .pid;
            entered();
            return fn(tx);
          }, options),
      },
    });
    const waiter = createAdCancel(d)
      .withdraw(f.approver, r.id, {})
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    const observer = createPrismaClient({
      connectionString: testDatabaseUrl(db.name, { role: null }),
      max: 1,
    });
    try {
      await connected;
      expect(writerPid).toBeGreaterThan(0);
      expect(waiterPid).not.toBe(writerPid);
      let blocked = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const [backend] = await observer.$queryRaw<
          { waiting: boolean; blockers: number[]; query: string }[]
        >`
          SELECT wait_event_type = 'Lock' AS waiting, pg_blocking_pids(pid) AS blockers, query
          FROM pg_stat_activity WHERE pid = ${waiterPid}`;
        if (backend?.waiting) {
          expect(backend.blockers).toContain(writerPid);
          expect(backend.query).toContain('FROM "ad"');
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      release();
      await writer;
      expect(await waiter).toMatchObject({ value: { status: "not_executed" } });
      expect((await req(r.id)).approvalRequest).toMatchObject({
        status: "withdrawn",
        isDecidedBySystem: false,
      });
      expect((await adNow(f)).status).toBe("confirmed");
    } finally {
      release();
      await writer;
      await waiter;
      await observer.$disconnect();
    }
  });
});
