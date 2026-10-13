import { beforeAll, describe, expect, it, vi } from "vitest";
import { QUALIFICATION_DUPLICATE_REJECT_NOTE } from "@liyoxi/contract";
import { claimDeliveries, consumeDelivery, createEvents } from "../events/index.js";
import type { DeliveryRef } from "../events/index.js";
import {
  alertsOf,
  alertsPort,
  createIdentityContext,
  defineRegistration,
  implement,
  invariantsPort,
} from "../kernel/index.js";
import type { DeliveredEvent, ModuleRegistration } from "../kernel/index.js";
import { assembleForTest, createRecordingPorts, useSeededDatabase } from "../testing/index.js";
import { runTestInvariants as runInvariants } from "../testing/index.js";
import { complete, harness, submit, uscc } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import {
  branchReady,
  newStoreReady,
  qualified,
  replacementLicense,
  reviewer,
} from "./__fixtures__/rounds.js";
import * as duplicateBatch from "./qualification-duplicate-batch.js";
import { createProfileConsistencyTransactions } from "./consistency-transactions.js";
import {
  createProfileConsistencyAssembly,
  createProfileQualificationConsistency,
} from "./qualification-consistency.js";

const db = useSeededDatabase("services", { max: 1 }),
  ports = createRecordingPorts();
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma(), [ports.registration]);
}, 120000);
const round = (id: string) =>
  h.prisma.qualificationSubmission.findUniqueOrThrow({
    where: { id },
    include: { approvalRequest: true },
  });
async function pending(number = uscc()) {
  const world = await h.owner(),
    ready = await complete(h, world.viewer, number);
  await submit(h, world.viewer, ready.submissionId);
  return { ...world, ready };
}
function binding(events = h.events, registration: ModuleRegistration = ports.registration) {
  const scope = createProfileConsistencyAssembly(
    assembleForTest({ entry: "api", extra: [registration] }),
  );
  const commits = createProfileConsistencyTransactions(h.tx, () => {});
  const service = createProfileQualificationConsistency({
    ...h,
    assembly: scope.assembly,
    events,
    commits,
  });
  scope.attach(service);
  const transport = createEvents({ tx: h.tx, clock: h.clock, assembly: scope.assembly });
  return { ...scope, service, transport, tx: commits.tx };
}
async function approvedEvent(
  storeId: string,
  type = "store.qualification.approved",
): Promise<DeliveredEvent> {
  const event = await h.prisma.outboxEvent.findFirstOrThrow({
    where: { aggregateId: storeId, eventType: type },
    orderBy: { id: "desc" },
  });
  return {
    id: event.id,
    type: event.eventType,
    payload: event.payload as Readonly<Record<string, unknown>>,
  };
}
async function delivery(eventId: string): Promise<DeliveryRef> {
  while ((await h.events.expand()).events > 0);
  const result = await h.tx.run((tx) => claimDeliveries(tx, 1000));
  const ref = result.claimed.find(
    (r) => r.eventId === eventId && r.subscriber === "profile.onQualificationApproved",
  );
  if (!ref) throw new Error("未认领到真实资质通过投递");
  return ref;
}
const consume = (b: ReturnType<typeof binding>, ref: DeliveryRef) =>
  consumeDelivery(
    { tx: b.tx, subscribers: b.transport.subscribers, alerts: alertsOf(b.assembly) },
    ref,
  );
const handle = (b: ReturnType<typeof binding>, event: DeliveredEvent) =>
  b.tx.run((tx) => b.assembly.subscriber("profile.onQualificationApproved")!.handle(tx, event));
const refs = (docId: string) =>
  h.prisma.fileRef.findMany({ where: { refType: "qualification_doc", refId: docId } });

describe("W2-11 I7与资质通过订阅共用真实系统决定", { timeout: 60000 }, () => {
  it("真实consumer拒绝正确initial轮次、系统审批/三链历史/证据同成，重复投递零新增且报告无敏感值", async () => {
    const number = uscc(),
      loser = await pending(number),
      winner = await pending(number);
    const beforeReports = ports.reports.length,
      beforeAlerts = ports.alerts.length;
    await h.profile.approve(reviewer, winner.ready.submissionId, {
      lockVersion: 0,
      confirm: { roundNo: 1 },
    });
    const b = binding(),
      event = await approvedEvent(winner.store.id),
      ref = await delivery(event.id);
    expect(await consume(b, ref)).toBe("done");
    const decided = await round(loser.ready.submissionId);
    expect(decided).toMatchObject({
      outcome: "rejected",
      systemRejectCode: "duplicate_entity",
      closedAt: h.clock.now(),
      approvalRequest: {
        status: "rejected",
        isDecidedBySystem: true,
        decidedByStaffId: null,
        decisionNote: QUALIFICATION_DUPLICATE_REJECT_NOTE,
        reasonCodes: [],
      },
    });
    expect(
      await h.prisma.entity.findUniqueOrThrow({ where: { id: loser.entity.id } }),
    ).toMatchObject({ verificationStatus: "rejected" });
    expect(await h.prisma.store.findUniqueOrThrow({ where: { id: loser.store.id } })).toMatchObject(
      { qualificationStatus: "rejected" },
    );
    expect(
      await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: loser.ready.docId } }),
    ).toMatchObject({ verdict: "rejected", effectiveAt: null, removedAt: null });
    expect(await refs(loser.ready.docId)).toMatchObject([{ state: "live" }]);
    for (const subjectId of [loser.entity.id, loser.store.id, decided.approvalRequestId!])
      expect(
        await h.prisma.statusTransition.count({ where: { subjectId, toState: "rejected" } }),
      ).toBe(1);
    const rejected = await h.prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: loser.store.id, eventType: "store.qualification.rejected" },
    });
    expect(rejected.payload).toMatchObject({
      submissionId: decided.id,
      isSystem: true,
      isFinal: false,
      reasonCodes: [],
    });
    expect(await consume(b, ref)).toBe("stale");
    await handle(b, event);
    expect(ports.reports.slice(beforeReports)).toMatchObject([
      { code: "profile.I7", subject: { id: decided.id }, healed: { at: h.clock.now() } },
    ]);
    expect(ports.alerts.slice(beforeAlerts)).toHaveLength(1);
    const reported = JSON.stringify([
      ports.reports.slice(beforeReports),
      ports.alerts.slice(beforeAlerts),
      rejected.payload,
    ]);
    expect(reported).not.toContain(number);
    expect(reported).not.toMatch(/certNoBidx|usccBidx|uscc_enc/);
    b.close();
  });

  it("change拒绝只针对新执照，旧主体/档案/生效证据保持且其他提交证照仍accepted", async () => {
    const loser = await qualified(h),
      winner = await qualified(h),
      number = uscc();
    const beforeEntity = await h.prisma.entity.findUniqueOrThrow({
      where: { id: loser.entity.id },
    });
    const beforeProfile = await h.prisma.storeProfile.findUniqueOrThrow({
      where: { storeId: loser.store.id },
    });
    const changed = await replacementLicense(h, loser.viewer, number),
      other = await branchReady(h, loser.viewer);
    await replacementLicense(h, winner.viewer, number);
    const loserRound = (await h.profile.qualification(loser.viewer)).openRound!
      .qualificationSubmissionId;
    const winnerRound = (await h.profile.qualification(winner.viewer)).openRound!
      .qualificationSubmissionId;
    await submit(h, loser.viewer, loserRound);
    await submit(h, winner.viewer, winnerRound);
    await h.profile.approve(reviewer, winnerRound, { lockVersion: 0, confirm: { roundNo: 2 } });
    const b = binding();
    await handle(b, await approvedEvent(winner.store.id, "store.qualification_change.approved"));
    expect(await round(loserRound)).toMatchObject({
      outcome: "rejected",
      systemRejectCode: "duplicate_entity",
      roundNo: 2,
    });
    expect(await h.prisma.entity.findUniqueOrThrow({ where: { id: loser.entity.id } })).toEqual(
      beforeEntity,
    );
    expect(
      await h.prisma.storeProfile.findUniqueOrThrow({ where: { storeId: loser.store.id } }),
    ).toMatchObject({
      effectiveQualificationSubmissionId: beforeProfile.effectiveQualificationSubmissionId,
      firstVerifiedAt: beforeProfile.firstVerifiedAt,
    });
    expect(
      await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: loser.ready.docId } }),
    ).toMatchObject({ verdict: "accepted", supersededAt: null });
    expect(
      await h.prisma.qualificationDoc.findUniqueOrThrow({
        where: { id: changed.doc.qualificationDocId },
      }),
    ).toMatchObject({ verdict: "rejected", effectiveAt: null });
    expect(
      await h.prisma.qualificationDoc.findUniqueOrThrow({
        where: { id: other.doc.qualificationDocId },
      }),
    ).toMatchObject({ verdict: "accepted", effectiveAt: null });
    for (const id of [
      loser.ready.docId,
      changed.doc.qualificationDocId,
      other.doc.qualificationDocId,
    ])
      expect(await refs(id)).toMatchObject([{ state: "live" }]);
    expect(
      await h.prisma.statusTransition.findFirstOrThrow({
        where: { subjectId: loser.store.id, event: "qualification.change_reject" },
      }),
    ).toMatchObject({
      fromState: "verified",
      toState: "verified",
      actorType: "system",
      actorId: null,
    });
    b.close();
  });

  it("I7限定被检查主体但全局含closed认证赢家；同事务落heal_and_alert，重跑零新决定", async () => {
    const number = uscc(),
      loser = await pending(number),
      excluded = await pending(number),
      winner = await pending(number);
    await h.profile.approve(reviewer, winner.ready.submissionId, {
      lockVersion: 0,
      confirm: { roundNo: 1 },
    });
    await h.prisma.entity.update({
      where: { id: winner.entity.id },
      data: { lifecycle: "closed", closedAt: h.clock.now() },
    });
    const b = binding(),
      input = {
        mode: "full",
        trigger: "manual",
        entityIds: [loser.entity.id],
        codes: ["profile.I7"],
      } as const;
    expect(b.assembly.invariant("profile.I7")).toBe(
      b.assembly.invariants.find((c) => c.code === "profile.I7"),
    );
    expect(
      await runInvariants({ tx: b.tx, assembly: b.assembly, clock: h.clock }, input),
    ).toMatchObject({
      status: "succeeded",
      checksRun: 1,
      violationsFound: 1,
      created: 1,
      autoClosed: 0,
      errors: [],
    });
    expect(
      await h.prisma.invariantViolation.findFirstOrThrow({
        where: { code: "profile.I7", subjectId: loser.ready.submissionId },
      }),
    ).toMatchObject({
      autoHealedAt: h.clock.now(),
      resolvedAt: null,
      detail: { systemRejectCode: "duplicate_entity", verifiedEntityId: winner.entity.id },
    });
    expect(await round(excluded.ready.submissionId)).toMatchObject({
      closedAt: null,
      approvalRequest: { status: "pending" },
    });
    expect(
      await runInvariants({ tx: b.tx, assembly: b.assembly, clock: h.clock }, input),
    ).toMatchObject({ status: "succeeded", violationsFound: 0 });
    // 后续case不受本组故意留下的scope外违规影响。
    await b.tx.run((tx) =>
      b.service.runI7(tx, { entityIds: [excluded.entity.id] }, { now: h.clock.now() }),
    );
    b.close();
  });

  it("旧通过事件不能拒绝后来另一信用码轮次；当前change事件才拒绝，新店事件不扇出且伪造payload零写", async () => {
    const firstCode = uscc(),
      winner = await pending(firstCode),
      loser = await pending(firstCode);
    await h.profile.approve(reviewer, winner.ready.submissionId, {
      lockVersion: 0,
      confirm: { roundNo: 1 },
    });
    const oldEvent = await approvedEvent(winner.store.id),
      nextCode = uscc();
    await h.profile.reject(reviewer, loser.ready.submissionId, {
      confirm: { roundNo: 1 },
      reasonCodes: ["R01"],
      note: "人工补正",
    });
    await replacementLicense(h, loser.viewer, nextCode);
    const next = (await h.profile.qualification(loser.viewer)).openRound!.qualificationSubmissionId;
    await submit(h, loser.viewer, next);
    await replacementLicense(h, winner.viewer, nextCode);
    const winnerNext = (await h.profile.qualification(winner.viewer)).openRound!
      .qualificationSubmissionId;
    await submit(h, winner.viewer, winnerNext);
    await h.profile.approve(reviewer, winnerNext, { lockVersion: 0, confirm: { roundNo: 2 } });
    const b = binding(),
      currentEvent = await approvedEvent(winner.store.id, "store.qualification_change.approved");
    await handle(b, oldEvent);
    expect(await round(next)).toMatchObject({
      closedAt: null,
      approvalRequest: { status: "pending" },
    });
    await expect(
      handle(b, {
        ...currentEvent,
        payload: { ...currentEvent.payload, entityId: loser.entity.id },
      }),
    ).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
    await handle(b, currentEvent);
    expect(await round(next)).toMatchObject({
      outcome: "rejected",
      systemRejectCode: "duplicate_entity",
    });
    expect(await round(loser.ready.submissionId)).toMatchObject({
      systemRejectCode: null,
      approvalRequest: { reasonCodes: ["R01"], decisionNote: "人工补正" },
    });
    const child = await newStoreReady(h, winner.viewer);
    await submit(h, child.viewer, child.roundId);
    await h.profile.approve(reviewer, child.roundId, { lockVersion: 0, confirm: { roundNo: 1 } });
    await handle(b, await approvedEvent(child.store.id));
    expect(await round(child.roundId)).toMatchObject({
      outcome: "approved",
      systemRejectCode: null,
    });
    b.close();
  });

  it("整批第二个真实事件失败使全部系统决定/历史/证照回滚，consumer重试后完整提交", async () => {
    const number = uscc(),
      first = await pending(number),
      second = await pending(number),
      winner = await pending(number);
    await h.profile.approve(reviewer, winner.ready.submissionId, {
      lockVersion: 0,
      confirm: { roundNo: 1 },
    });
    let emitted = 0;
    const bad = binding({
      ...h.events,
      async emit(tx, ctx, input) {
        const result = await h.events.emit(tx, ctx, input);
        if (input.type === "store.qualification.rejected" && ++emitted === 2)
          throw new Error("lyxtest_second_reject_rollback");
        return result;
      },
    });
    const event = await approvedEvent(winner.store.id),
      ref = await delivery(event.id),
      reportCount = ports.reports.length,
      alertCount = ports.alerts.length;
    expect(await consume(bad, ref)).toBe("retry");
    for (const candidate of [first, second]) {
      expect(await round(candidate.ready.submissionId)).toMatchObject({
        closedAt: null,
        systemRejectCode: null,
        approvalRequest: { status: "pending", isDecidedBySystem: false },
      });
      expect(
        await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: candidate.ready.docId } }),
      ).toMatchObject({ verdict: null });
      expect(
        await h.prisma.statusTransition.count({
          where: { subjectId: candidate.store.id, toState: "rejected" },
        }),
      ).toBe(0);
      expect(await refs(candidate.ready.docId)).toMatchObject([{ state: "live" }]);
    }
    expect(ports.reports).toHaveLength(reportCount);
    expect(ports.alerts).toHaveLength(alertCount);
    // handle完整返回后、consume标done之前再失败，也不产生提交后假healed/告警。
    const afterHandle = binding();
    await expect(
      afterHandle.tx.run(async (tx) => {
        await afterHandle.service.onQualificationApproved(tx, event);
        throw new Error("lyxtest_consume_late_rollback");
      }),
    ).rejects.toThrow("lyxtest_consume_late_rollback");
    expect(ports.reports).toHaveLength(reportCount);
    expect(ports.alerts).toHaveLength(alertCount);
    await afterHandle.close();
    await h.prisma.outboxDelivery.updateMany({
      where: { outboxEventId: event.id, subscriber: ref.subscriber },
      data: { nextAttemptAt: new Date(0) },
    });
    const retry = (await h.tx.run((tx) => claimDeliveries(tx, 1000))).claimed.find(
      (r) => r.eventId === event.id && r.subscriber === ref.subscriber,
    )!;
    // 私有候选查询只缩小测试批，生产写死32；两个真实对象覆盖串行提交续批。
    const original = duplicateBatch.qualificationDuplicateBatch;
    const batching = vi
      .spyOn(duplicateBatch, "qualificationDuplicateBatch")
      .mockImplementation(async (...args) => {
        const batch = await original(...args);
        return { ids: batch.ids.slice(0, 1), more: batch.more || batch.ids.length > 1 };
      });
    const good = binding();
    try {
      expect(await consume(good, retry)).toBe("done");
    } finally {
      batching.mockRestore();
    }
    expect(ports.reports).toHaveLength(reportCount + 2);
    expect(ports.alerts).toHaveLength(alertCount + 2);
    for (const candidate of [first, second])
      expect(await round(candidate.ready.submissionId)).toMatchObject({
        outcome: "rejected",
        systemRejectCode: "duplicate_entity",
      });
    bad.close();
    good.close();
  });

  it("仅system标签/round标志不能空原因拒绝；绑定只一次、关闭隔离且原生命周期handle不丢", async () => {
    const code = uscc(),
      candidate = await pending(code),
      verified = await pending(code);
    await h.profile.approve(reviewer, verified.ready.submissionId, {
      lockVersion: 0,
      confirm: { roundNo: 1 },
    });
    const system = createIdentityContext({
      actor: { type: "system", job: "lyxtest_spoof_duplicate" },
    });
    await expect(
      h.profile.reject(system, candidate.ready.submissionId, {
        confirm: { roundNo: 1 },
        reasonCodes: [],
        note: QUALIFICATION_DUPLICATE_REJECT_NOTE,
      }),
    ).rejects.toThrow();
    await h.prisma.qualificationSubmission.update({
      where: { id: candidate.ready.submissionId },
      // 遵守系统原因/结论/关闭配对CHECK；历史标志不能授权当前系统决定。
      data: { systemRejectCode: "duplicate_entity", outcome: "rejected", closedAt: h.clock.now() },
    });
    await expect(
      h.tx.run((tx) =>
        h.tenant.setStoreQualification(tx, system, {
          storeId: candidate.store.id,
          submissionId: candidate.ready.submissionId,
          round: "initial",
          action: "reject",
          rejection: { reasonCodes: [], note: QUALIFICATION_DUPLICATE_REJECT_NOTE },
        }),
      ),
    ).rejects.toThrow();
    expect(await round(candidate.ready.submissionId)).toMatchObject({
      closedAt: h.clock.now(),
      outcome: "rejected",
      approvalRequest: { status: "pending" },
    });
    expect(
      await h.prisma.store.findUniqueOrThrow({ where: { id: candidate.store.id } }),
    ).toMatchObject({ qualificationStatus: "pending" });
    await h.prisma.qualificationSubmission.update({
      where: { id: candidate.ready.submissionId },
      data: { systemRejectCode: null, outcome: null, closedAt: null },
    });
    const base = assembleForTest({ entry: "api", extra: [ports.registration] }),
      scope = createProfileConsistencyAssembly(base),
      peer = binding();
    expect(scope.assembly.subscriber("profile.onTenantLifecycle")!.handle).toBe(
      base.subscriber("profile.onTenantLifecycle")!.handle,
    );
    await expect(
      h.tx.run((tx) =>
        scope.assembly.invariant("profile.I7")!.run!(tx, {}, { now: h.clock.now() }),
      ),
    ).rejects.toThrow("未绑定或已关闭");
    const isolatedCommits = createProfileConsistencyTransactions(h.tx, () => {});
    const isolated = createProfileQualificationConsistency({
      ...h,
      assembly: scope.assembly,
      commits: isolatedCommits,
    });
    scope.attach(isolated);
    expect(() => scope.attach(isolated)).toThrow("只能绑定一次");
    await scope.close();
    await expect(
      h.tx.run((tx) =>
        scope.assembly.invariant("profile.I7")!.run!(tx, {}, { now: h.clock.now() }),
      ),
    ).rejects.toThrow("未绑定或已关闭");
    expect(
      await peer.tx.run((tx) =>
        peer.service.runI7(tx, { entityIds: [candidate.entity.id] }, { now: h.clock.now() }),
      ),
    ).toMatchObject([
      { subject: { id: candidate.ready.submissionId }, healed: { at: h.clock.now() } },
    ]);
    await peer.close();
    const duplicateCode = uscc(),
      waiting = await pending(duplicateCode),
      winner = await pending(duplicateCode);
    await h.profile.approve(reviewer, winner.ready.submissionId, {
      lockVersion: 0,
      confirm: { roundNo: 1 },
    });
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = binding(
      h.events,
      defineRegistration("lyxtest_consistency_closing", {
        portImplementations: [
          implement(invariantsPort, {
            report: async () => {
              enter();
              await released;
              throw new Error("lyxtest_notification_port_failure");
            },
          }),
          implement(alertsPort, { raise: async () => {} }),
        ],
      }),
    );
    const active = handle(blocked, await approvedEvent(winner.store.id));
    await entered;
    let finished = false;
    const closing = blocked.close().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    // max1连接已释放，业务真实提交；close仍必须等通知完成。
    expect(await round(waiting.ready.submissionId)).toMatchObject({ outcome: "rejected" });
    release();
    await active;
    await closing;
    expect(finished).toBe(true);
  });
});
