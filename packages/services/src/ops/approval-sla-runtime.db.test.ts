import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApproval, approvalKindsOf } from "../approval/index.js";
import { createFlow } from "../flow/index.js";
import { createMedia } from "../media/index.js";
import { createProfile } from "../profile/index.js";
import { createTenant } from "../tenant/index.js";
import { createStaffManagement } from "../staff/index.js";
import { createCalendarAdmin, createSla } from "../sla/index.js";
import {
  createBizNoIssuer,
  createIdentityContext,
  createTxRunner,
  staffWorkSourcesOf,
  uuidv7,
} from "../kernel/index.js";
import type { DeliveredEvent } from "../kernel/index.js";
import type { DeliveryRef } from "../events/index.js";
import type { TimerRef } from "../timers/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  fullStaffWorld,
  sampleStaffContext,
  TEST_KEYRING,
  useSeededDatabase,
} from "../testing/index.js";
import { createApprovalSlaAssembly } from "./approval-sla-runtime.js";
import { buildWorkerServices } from "./worker.js";

const db = useSeededDatabase("services", { label: "approvalworker" });
const clock = createClock(new Date("2026-01-05T01:00:00Z"));
let prisma: Awaited<ReturnType<typeof db.prisma>>;
let tx: ReturnType<typeof createTxRunner>;
let worker: ReturnType<typeof buildWorkerServices>;
let calendar: ReturnType<typeof createCalendarAdmin>;
let actor: Parameters<ReturnType<typeof createCalendarAdmin>["import"]>[0];
const eventRefs: DeliveryRef[] = [],
  timerRefs: TimerRef[] = [];
const owned: ReturnType<typeof buildWorkerServices>[] = [];
beforeAll(async () => {
  prisma = await db.prisma();
  tx = createTxRunner({ prisma, appEnv: "test" });
  worker = build();
  const staff = await createFactories({ db: prisma, clock }).staff({ staffRoleKey: "super_admin" });
  actor = {
    staff: await sampleStaffContext(prisma, staff.id, { stepUpAt: clock.now() }),
    identity: createIdentityContext({ actor: { type: "staff", id: staff.id, client: "admin" } }),
  };
  calendar = createCalendarAdmin({ tx, clock, events: worker.events });
  for (const item of [
    {
      dictTypeKey: "industry",
      code: "W227I",
      parentCode: null,
      ext: { open: true, special: false, requiredCerts: [] },
    },
    {
      dictTypeKey: "industry",
      code: "W227C",
      parentCode: "W227I",
      ext: { open: true, special: false, requiredCerts: [] },
    },
    ...["W227P", "W227M", "W227D"].map((code, index) => ({
      dictTypeKey: "region",
      code,
      parentCode: index === 0 ? null : ["W227P", "W227M"][index - 1]!,
      ext: { level: index + 1, functionalZone: false, opened: true },
    })),
  ])
    await prisma.dictItem.create({
      data: {
        ...item,
        id: uuidv7(),
        name: item.code,
        isEnabled: true,
        position: 999,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
}, 120_000);
afterAll(async () => {
  for (const one of owned.reverse()) {
    one.closeApproval?.();
    await one.shutdownMediaJobs?.();
    one.closeMediaJobs?.();
    await one.closeDocs();
    await one.documentConverter?.close();
    await one.closeNotify();
    await one.closeAnalytics?.();
    await one.closeStaff?.();
    await one.closeSmsHealth?.();
    await one.closeAlertFacts?.();
    one.closeOrder?.();
    one.closeBillingTimers?.();
    one.closePublish?.();
    one.closeDelivery?.();
    one.closeWebhooks?.();
    await one.closeMediaDrivers?.();
    await one.closeStorageDrivers?.();
  }
});
function build(otherClock = clock) {
  const one = buildWorkerServices({
    appEnv: "test",
    prisma,
    clock: otherClock,
    assembly: assembleForTest({ entry: "worker" }),
    providers: createFakeProviders({ clock: otherClock }),
    channel: {
      downForMs: () => 0,
      enqueue: async (_queue, _id, raw) => {
        if (typeof raw !== "object" || raw === null) return;
        if (
          "eventId" in raw &&
          "subscriber" in raw &&
          "dispatchNo" in raw &&
          typeof raw.eventId === "string" &&
          typeof raw.subscriber === "string" &&
          typeof raw.dispatchNo === "number"
        )
          eventRefs.push({
            eventId: raw.eventId,
            subscriber: raw.subscriber,
            dispatchNo: raw.dispatchNo,
          });
        if (
          "timerId" in raw &&
          "kind" in raw &&
          "dispatchNo" in raw &&
          typeof raw.timerId === "string" &&
          typeof raw.kind === "string" &&
          typeof raw.dispatchNo === "number"
        )
          timerRefs.push({ timerId: raw.timerId, kind: raw.kind, dispatchNo: raw.dispatchNo });
      },
    },
  });
  owned.push(one);
  return one;
}
const importBody = (day = clock.now().toISOString().slice(0, 10)) => ({
  year: 2026,
  days: [{ date: day, kind: "holiday" as const, note: "独立worker验收" }],
  source: "测试工作日更正",
});
let sequence = 0;
function uscc() {
  const chars = "0123456789ABCDEFGHJKLMNPQRTUWXY";
  const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  const prefix = `91310000MA1K${String(++sequence).padStart(5, "0")}`;
  const sum = [...prefix].reduce((n, c, i) => n + chars.indexOf(c) * weights[i]!, 0);
  return prefix + chars[(31 - (sum % 31)) % 31];
}
async function imported(one = worker, day?: string) {
  const result = await createCalendarAdmin({ tx, clock, events: one.events }).import(
    actor,
    importBody(day),
  );
  expect(result.isChanged).toBe(true);
  const event = await prisma.outboxEvent.findFirstOrThrow({
    where: {
      eventType: "calendar.imported",
      dedupeKey: `calendar.imported:${result.calendarVersion}`,
    },
  });
  await one.relay();
  await one.dispatch();
  const refs = eventRefs.filter((ref) => ref.eventId === event.id);
  expect(refs.map((ref) => ref.subscriber).sort()).toEqual([
    "approval.onCalendarImported",
    "staff.onCalendarImported",
  ]);
  return { event, refs, result };
}
async function consumeBoth(one: ReturnType<typeof buildWorkerServices>, refs: DeliveryRef[]) {
  for (const ref of refs) expect(await one.consume(ref)).toBe("done");
  const rows = await prisma.outboxDelivery.findMany({ where: { outboxEventId: refs[0]!.eventId } });
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.status === "done" && row.consumedAt !== null)).toBe(true);
}
async function realQualification() {
  const assembly = worker.assembly,
    events = worker.events;
  const flow = createFlow({ assembly, clock, events });
  const fake = createFakeProviders({ clock });
  const make = createFactories({ db: prisma, clock });
  const approval = createApproval({
    assembly,
    clock,
    flow,
    events,
    bizNo: createBizNoIssuer({ clock, appEnv: "test" }),
    sla: createSla({ clock, assembly }),
    timers: worker.timers,
  });
  const profile = createProfile({
    tx,
    clock,
    assembly,
    events,
    approval,
    tenant: createTenant({ tx, clock, flow, assembly }),
    media: createMedia({ tx, clock, assembly, events, storage: fake.storage }),
    keyring: () => TEST_KEYRING,
    wechat: fake.wechat,
    currentOpenid: async () => "lyxtest_worker_qualification",
  });
  const user = await make.merchantUser();
  const entity = await make.entity({ createdByUserId: user.id });
  const store = await make.store({ entityId: entity.id, isPrimary: true });
  const member = await make.entityMember({
    entityId: entity.id,
    merchantUserId: user.id,
    role: "owner",
  });
  const viewer = {
    ctx: createIdentityContext({
      actor: { type: "merchant" as const, id: user.id, client: "weapp" as const },
    }),
    principal: {
      sessionId: user.id,
      merchantUserId: user.id,
      wechatIdentityId: user.id,
      consentStamp: "test",
    },
    membership: {
      memberId: member.id,
      entityId: entity.id,
      storeId: store.id,
      role: "owner" as const,
      storeMode: "active" as const,
    },
  };
  await profile.updateBasic(viewer, {
    draft: false,
    lockVersion: 0,
    brandName: "测试品牌",
    storeName: "测试门店",
    industryCode: "W227I",
    categoryCode: "W227C",
    address: {
      provinceCode: "W227P",
      cityCode: "W227M",
      districtCode: "W227D",
      zoneCode: null,
      detail: "测试路一号",
      poiName: null,
      latitude: null,
      longitude: null,
    },
    businessHours: [{ start: "09:00", end: "18:00" }],
    storeTel: "010-12345678",
    avgSpendFen: 10000,
  });
  const file = (category: "profile_image" | "kyc_license") =>
    make.fileObject({
      category,
      bucket: category === "kyc_license" ? "secure" : "asset",
      scopeType: category === "kyc_license" ? "entity" : "store",
      entityId: entity.id,
      storeId: category === "kyc_license" ? null : store.id,
      uploadActorType: "merchant",
      uploadActorId: user.id,
      uploadClient: "weapp",
    });
  const images = await Promise.all(Array.from({ length: 4 }, () => file("profile_image")));
  await profile.updateMedia(viewer, {
    draft: false,
    lockVersion: 1,
    groups: {
      door: [{ fileId: images[0]!.id }],
      interior: images.slice(1).map((row) => ({ fileId: row.id })),
    },
  });
  await profile.updateService(viewer, {
    draft: false,
    lockVersion: 2,
    serviceItems: [{ name: "测试服务", priceFen: 1000 }],
    sellingPointCodes: ["SP01"],
  });
  await profile.updateContact(viewer, { lockVersion: 3, name: "测试联系人", phoneSource: "login" });
  const draft = await profile.updateQualification(viewer, {
    lockVersion: null,
    claimedEntityType: "enterprise",
    declarationConfirmed: true,
    declarationVersion: "1",
  });
  const license = await file("kyc_license");
  const doc = await profile.createDocument(viewer, {
    fileId: license.id,
    docType: "business_license",
  });
  await profile.updateDocument(viewer, doc.doc.qualificationDocId, {
    lockVersion: doc.lockVersion,
    fields: {
      name: "测试认证主体",
      uscc: uscc(),
      principal: "张测试",
      principalRole: "legal_rep",
      subjectType: "enterprise",
      validFrom: "2020-01-01",
      validTo: "long_term",
      address: "测试营业地址",
    },
  });
  const submitted = await profile.submit(viewer, {
    qualificationSubmissionId: draft.openRound!.qualificationSubmissionId,
    declarationConfirmed: true,
    declarationVersion: "1",
  });
  const round = await prisma.qualificationSubmission.findUniqueOrThrow({
    where: { id: submitted.openRound!.qualificationSubmissionId },
  });
  return prisma.approvalRequest.findUniqueOrThrow({ where: { id: round.approvalRequestId! } });
}
async function realAssignment() {
  const w = await fullStaffWorld(prisma);
  try {
    const flow = createFlow({ assembly: worker.assembly, clock, events: worker.events });
    const service = createStaffManagement({
      ...w.deps,
      clock,
      flow,
      events: worker.events,
      sla: createSla({ clock, assembly: worker.assembly }),
      timers: worker.timers,
      workSources: staffWorkSourcesOf(worker.assembly),
    });
    const from = await w.person("delivery_manager"),
      to = await w.person("delivery_manager");
    const store = await createFactories({ db: prisma, clock }).store({
      deliveryManagerId: from.id,
    });
    await service.handover(
      await sampleStaffContext(prisma, w.operator.id, { stepUpAt: clock.now() }),
      w.actor,
      from.id,
      { handoverToStaffId: to.id, reason: "reassigned" },
    );
    return prisma.assignmentHistory.findFirstOrThrow({
      where: { subjectId: store.id, source: "store_manager" },
    });
  } finally {
    await w.scope.close();
  }
}
describe("独立 worker 审批 SLA 装配", { timeout: 120_000 }, () => {
  it("只建buildWorkerServices，真实导入的同一event两订阅者done，重复投递/导入零副作用", async () => {
    // This runs before any createApproval; there is no API runtime/SLA binding in this file.
    const { refs } = await imported();
    await consumeBoth(worker, refs);
    const before = await prisma.outboxEvent.count();
    for (const ref of refs) expect(await worker.consume(ref)).toBe("stale");
    expect((await calendar.import(actor, importBody())).isChanged).toBe(false);
    expect(await prisma.outboxEvent.count()).toBe(before);
  });
  it("真实资格提交与改派：非空两owner重算原快照、取消旧timer并经worker到点，重复零事件", async () => {
    await calendar.import(actor, { year: 2026 });
    const request = await realQualification(),
      assignment = await realAssignment();
    expect(request.dueAt).not.toBeNull();
    expect(assignment.contactDueAt).not.toBeNull();
    const prior = await prisma.timer.findMany({
      where: { subjectId: { in: [request.id, assignment.id] }, status: "scheduled" },
    });
    expect(prior).toHaveLength(2);
    const { refs, result } = await imported();
    await consumeBoth(worker, refs);
    const next = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } });
    const contact = await prisma.assignmentHistory.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(next.status).toBe("pending");
    expect(next.dueAt).not.toEqual(request.dueAt);
    expect(contact.contactDueAt).not.toEqual(assignment.contactDueAt);
    expect(next.slaSnapshot).toMatchObject({ calendarVersion: result.calendarVersion });
    expect(contact.slaSnapshot).toMatchObject({ calendarVersion: result.calendarVersion });
    expect(
      (await prisma.timer.findMany({ where: { id: { in: prior.map((row) => row.id) } } })).every(
        (row) => row.status === "cancelled",
      ),
    ).toBe(true);
    const active = await prisma.timer.findMany({
      where: { subjectId: { in: [request.id, assignment.id] }, status: "scheduled" },
    });
    expect(active).toHaveLength(2);
    expect(active.find((row) => row.subjectId === request.id)?.dedupeKey).toBe(
      `sla.breach:approval_request:${request.id}:decision:${result.calendarVersion}`,
    );
    clock.set(new Date(Math.max(next.dueAt!.getTime(), contact.contactDueAt!.getTime()) + 1));
    await worker.scan();
    const due = timerRefs.filter((ref) => active.some((row) => row.id === ref.timerId));
    expect(due).toHaveLength(2);
    for (const ref of due) {
      expect(await worker.runTimer(ref)).toBe("fired");
      expect(await worker.runTimer(ref)).toBe("stale");
    }
    expect(
      await prisma.outboxEvent.count({
        where: { eventType: "approval.sla_breached", aggregateId: request.id },
      }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { eventType: "assignment.sla_breached", aggregateId: assignment.id },
      }),
    ).toBe(1);
  });
  it("真实导入emit后的失败回滚日期、批次、审计与outbox，无虚构outerTx", async () => {
    const before = await prisma.workCalendarDay.findMany({ orderBy: { day: "asc" } });
    const count = await prisma.outboxEvent.count(),
      audits = await prisma.auditLog.count();
    const failing = createCalendarAdmin({
      tx,
      clock,
      events: {
        emit: async (...args) => {
          await worker.events.emit(...args);
          throw new Error("owned after emit");
        },
      },
    });
    await expect(failing.import(actor, importBody("2026-01-06"))).rejects.toThrow(
      "owned after emit",
    );
    expect(await prisma.workCalendarDay.findMany({ orderBy: { day: "asc" } })).toEqual(before);
    expect(await prisma.outboxEvent.count()).toBe(count);
    expect(await prisma.auditLog.count()).toBe(audits);
  });
  it("subscriber真实重算后抛错：业务/计时/历史全回滚，delivery只记retry", async () => {
    await calendar.import(actor, { year: 2026 });
    const request = await realQualification();
    const { refs } = await imported();
    const ref = refs.find((row) => row.subscriber === "approval.onCalendarImported")!;
    const before = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } });
    const timers = await prisma.timer.findMany({
      where: { subjectId: request.id },
      orderBy: { id: "asc" },
    });
    const histories = await prisma.statusTransition.count({ where: { subjectId: request.id } });
    const subscriber = worker.events.subscribers.get(ref.subscriber)!;
    const original = subscriber.handle;
    const spy = vi.spyOn(subscriber, "handle").mockImplementation(async (...args) => {
      await original(...args);
      throw new Error("owned after recalculate");
    });
    try {
      expect(await worker.consume(ref)).toBe("retry");
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })).toEqual(
      before,
    );
    expect(
      await prisma.timer.findMany({ where: { subjectId: request.id }, orderBy: { id: "asc" } }),
    ).toEqual(timers);
    expect(await prisma.statusTransition.count({ where: { subjectId: request.id } })).toBe(
      histories,
    );
    expect(
      await prisma.outboxDelivery.findFirstOrThrow({
        where: { outboxEventId: ref.eventId, subscriber: ref.subscriber },
      }),
    ).toMatchObject({ status: "retry", attempts: 1, consumedAt: null });
  });
  it("两个真实worker不同clock，关闭一个不借另实例；存活实例仍两subscriber done", async () => {
    const other = build(createClock(new Date("2026-01-05T02:00:00Z")));
    const event: DeliveredEvent = {
      id: actor.staff.staff.id,
      type: "calendar.imported",
      payload: { v: 1, year: 2026, calendarVersion: 1, changedDays: [] },
    };
    other.closeApproval?.();
    other.closeApproval?.();
    await expect(
      tx.run((t) => other.assembly.subscriber("approval.onCalendarImported")!.handle(t, event)),
    ).rejects.toThrow("已经关闭");
    await expect(
      tx.run((t) =>
        other.assembly.timerHandler("sla.breach")!.handle(t, {
          id: actor.staff.staff.id,
          kind: "sla.breach",
          subjectType: "approval_request",
          subjectId: actor.staff.staff.id,
          payload: {},
        }),
      ),
    ).rejects.toThrow("已经关闭");
    await calendar.import(actor, { year: 2026 });
    const { refs } = await imported();
    await consumeBoth(worker, refs);
  });
  it("I1使用真实kind领域关联而非恒零；I3和关闭后的两校验均绑定本实例", async () => {
    const kinds = approvalKindsOf(worker.assembly);
    expect([...kinds.keys()].sort()).toEqual([
      "channel_account",
      "finance_config_change",
      "launch_link",
      "qualification",
    ]);
    const request = await realQualification();
    const inv = worker.assembly.invariant("approval.I1")!;
    const slaInv = worker.assembly.invariant("approval.I3")!;
    expect(await tx.run((t) => slaInv.run!(t, {}, { now: clock.now() }))).toEqual([]);
    await expect(
      tx.run(async (t) => {
        await t.approvalRequest.update({
          where: { id: request.id },
          data: { kind: "channel_account" },
        });
        expect(await inv.run!(t, {}, { now: clock.now() })).toEqual(
          expect.arrayContaining([expect.objectContaining({ subject: { id: request.id } })]),
        );
        throw new Error("rollback owned domain discrepancy");
      }),
    ).rejects.toThrow("rollback owned domain discrepancy");
    expect(
      (await prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id } })).kind,
    ).toBe("qualification");
    await expect(
      tx.run(async (t) => {
        await t.timer.updateMany({
          where: { subjectId: request.id, status: "scheduled" },
          data: { payload: { purpose: "decision", dueAt: "2020-01-01T00:00:00Z" } },
        });
        expect(await slaInv.run!(t, {}, { now: clock.now() })).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              subject: { type: "approval_request", id: request.id },
              detail: expect.objectContaining({ problem: "decision_timer_snapshot" }),
            }),
          ]),
        );
        throw new Error("rollback owned timer discrepancy");
      }),
    ).rejects.toThrow("rollback owned timer discrepancy");
    const other = build();
    other.closeApproval?.();
    for (const code of ["approval.I1", "approval.I3"])
      await expect(
        tx.run((t) => other.assembly.invariant(code)!.run!(t, {}, { now: clock.now() })),
      ).rejects.toThrow("已经关闭");
  });
  it("固定组合保唯一handler/订阅者与其他subject原委托，未绑定/重复绑定/错误登记拒绝", async () => {
    const base = assembleForTest({ entry: "worker" });
    const original = base.timerHandler("sla.breach")!;
    const sentinel = vi.fn(async () => "skipped" as const);
    const scope = createApprovalSlaAssembly({
      ...base,
      timerHandlers: base.timerHandlers.map((row) =>
        row === original ? { ...row, handle: sentinel } : row,
      ),
    });
    expect(scope.assembly.subscribers).toHaveLength(base.subscribers.length);
    expect(scope.assembly.timerHandlers).toHaveLength(base.timerHandlers.length);
    expect(scope.assembly.timerHandlers.filter((row) => row.kind === "sla.breach")).toHaveLength(1);
    await expect(
      tx.run((t) =>
        scope.assembly
          .subscriber("approval.onCalendarImported")!
          .handle(t, { id: uuidv7(), type: "calendar.imported", payload: {} }),
      ),
    ).rejects.toThrow("尚未绑定");
    await tx.run((t) =>
      scope.assembly.timerHandler("sla.breach")!.handle(t, {
        id: actor.staff.staff.id,
        kind: "sla.breach",
        subjectType: "other",
        subjectId: null,
        payload: null,
      }),
    );
    expect(sentinel).toHaveBeenCalledOnce();
    const flow = createFlow({ assembly: base, clock, events: worker.events });
    const deps = {
      clock,
      flow,
      events: worker.events,
      sla: createSla({ clock, assembly: base }),
      timers: worker.timers,
    };
    scope.attach(deps);
    expect(() => scope.attach(deps)).toThrow("只能绑定一次");
    scope.close();
    expect(() => scope.attach(deps)).toThrow("只能绑定一次");
    expect(() => createApprovalSlaAssembly({ ...base, subscribers: [] })).toThrow("唯一");
  });
});
