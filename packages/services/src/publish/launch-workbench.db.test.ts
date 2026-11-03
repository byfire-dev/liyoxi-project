import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublishWorkbenchFixture,
  notificationFixture,
  useSeededDatabase,
} from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import { createLaunchRevoke } from "./launch-revoke.js";
import { overdueLaunchReminderRule, launchReminderRule } from "./launch-reminders.js";
const db = useSeededDatabase("services", { max: 2 });
let h: ReturnType<typeof createPublishWorkbenchFixture>;
let n: ReturnType<typeof notificationFixture>;
let f: Awaited<ReturnType<typeof h.release>>;
let passed: Awaited<ReturnType<typeof h.prisma.launchSubmission.findMany>>;
beforeAll(async () => {
  h = createPublishWorkbenchFixture(await db.prisma());
  n = notificationFixture(h.prisma);
  f = await h.release(true, 2);
  h.clock.advance(1000);
  await h.prisma.paramValue.create({
    data: {
      id: uuidv7(),
      key: "launch.partial_goes_live",
      value: false,
      effectiveAt: h.clock.now(),
      createdAt: h.clock.now(),
      createdByStaffId: f.qc.row.id,
    },
  });
  const tasks = await h.prisma.launchTask.findMany({
    where: { deliveryTicketId: f.id },
    orderBy: { id: "asc" },
  });
  const submit = async (taskId: string, count: number) => {
    await h.deps.publish.submitLaunch(f.o.viewer, taskId, {
      linkKind: "episodes",
      collectionUrl: `https://example.invalid/m6/${taskId}`,
      episodeUrls: Array.from({ length: count }, (_, i) => ({
        episodeNo: i + 1,
        url: `https://example.invalid/${taskId}/${i + 1}`,
      })),
      reportedEpisodeCount: count,
      actualLaunchDate: "2026-01-05",
    });
    const s = await h.prisma.launchSubmission.findFirstOrThrow({
      where: { launchTaskId: taskId },
      orderBy: { roundNo: "desc" },
      include: { approvalRequest: true },
    });
    await h.deps.publish.approveLaunch(f.qc.ctx, f.qc.staff, s.id, {
      lockVersion: s.approvalRequest.lockVersion,
      confirm: { roundNo: s.roundNo, reportedEpisodeCount: count },
      verifiedEpisodeCount: count,
      ...(await h.checks("launch.verify")),
    });
  };
  await submit(tasks[0]!.id, 1);
  expect(await h.prisma.launchTask.findUnique({ where: { id: tasks[0]!.id } })).toMatchObject({
    isLive: false,
    verifiedEpisodeCount: 1,
    reviewStatus: "passed",
  });
  expect(await h.prisma.deliveryTicket.findUnique({ where: { id: f.id } })).toMatchObject({
    step: "awaiting_launch",
    liveAt: null,
  });
  for (const task of tasks) await submit(task.id, 2);
  passed = await h.prisma.launchSubmission.findMany({
    where: { launchTask: { deliveryTicketId: f.id }, verifiedEpisodeCount: 2 },
    orderBy: { id: "asc" },
  });
}, 120_000);
afterAll(async () => {
  await n?.service.close();
  await h?.close();
});
const service = () => createLaunchRevoke({ ...h.deps, approval: h.approval });
const reason = "核验截图复核发现发布链接错误";
const bodyOf = (row: (typeof passed)[number]) => ({
  reason,
  confirm: { roundNo: row.roundNo, verifiedEpisodeCount: row.verifiedEpisodeCount! },
});

describe("撤销核验的真实同事务闭环", () => {
  it("首次真实核验已上架；回显与工作日时限失败不改变旧审批", async () => {
    const body = bodyOf(passed[0]!);
    expect(await h.prisma.orderItem.findUnique({ where: { id: f.item.id } })).toMatchObject({
      phase: "live",
      liveEpisodeCount: 2,
    });
    const before = {
      audits: await h.prisma.auditLog.count(),
      events: await h.prisma.outboxEvent.count(),
      alerts: await h.prisma.alertEvent.count(),
    };
    expect(await h.deps.publish.launchSubmission(f.qc.staff, passed[0]!.id)).toMatchObject({
      revoke: { canRevoke: true, blockedReasons: [] },
      actions: ["revoke"],
    });
    expect({
      audits: await h.prisma.auditLog.count(),
      events: await h.prisma.outboxEvent.count(),
      alerts: await h.prisma.alertEvent.count(),
    }).toEqual(before);
    await expect(
      service().revoke(f.qc.ctx, f.qc.staff, passed[0]!.id, {
        ...body,
        confirm: { roundNo: 99, verifiedEpisodeCount: 2 },
      }),
    ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
    const now = h.clock.now();
    h.clock.set(new Date("2026-01-12T04:00:00Z"));
    await expect(service().revoke(f.qc.ctx, f.qc.staff, passed[0]!.id, body)).rejects.toMatchObject(
      { error: "LAUNCH_REVOKE_WINDOW_CLOSED" },
    );
    expect(await h.deps.publish.launchSubmission(f.qc.staff, passed[0]!.id)).toMatchObject({
      revoke: { canRevoke: false, blockedReasons: ["window_closed"] },
    });
    h.clock.set(now);
    expect(
      await h.prisma.approvalRequest.findUnique({ where: { id: passed[0]!.approvalRequestId } }),
    ).toMatchObject({ status: "approved" });
  });
  it("撤销一个账号不错误回退仍有live的订单，重开保留商家原始内容", async () => {
    const old = passed[0]!,
      body = bodyOf(old);
    const now = h.clock.now();
    // A pending patrol and its scheduled follow-up are historical inputs from W6-03.
    // This test proves the real revoke consumer, not the later patrol producer.
    const batch = await h.prisma.patrolBatch.create({
      data: { id: uuidv7(), weekStartDate: new Date("2026-01-05"), createdAt: now, updatedAt: now },
    });
    const patrol = await h.prisma.patrolTask.create({
      data: {
        id: uuidv7(),
        entityId: f.o.entity.id,
        storeId: f.o.store.id,
        patrolBatchId: batch.id,
        launchTaskId: old.launchTaskId,
        deliveryTicketId: f.id,
        orderItemId: f.item.id,
        source: "manual",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      },
    });
    const timer = await h.prisma.timer.create({
      data: {
        id: uuidv7(),
        kind: "patrol.followup",
        subjectType: "patrol_task",
        subjectId: patrol.id,
        entityId: f.o.entity.id,
        storeId: f.o.store.id,
        fireAt: new Date(now.getTime() + 3600000),
        dedupeKey: `patrol.followup:${patrol.id}`,
        status: "scheduled",
        createdAt: now,
        updatedAt: now,
      },
    });
    const follow = await h.prisma.followUp.create({
      data: {
        id: uuidv7(),
        subjectType: "patrol_task",
        subjectId: patrol.id,
        entityId: f.o.entity.id,
        storeId: f.o.store.id,
        channel: "system",
        content: "巡检后续处理",
        nextFollowAt: new Date(now.getTime() + 3600000),
        ownerStaffId: f.qc.row.id,
        actorType: "system",
        createdAt: now,
        updatedAt: now,
      },
    });
    const reopened = await service().revoke(f.qc.ctx, f.qc.staff, old.id, body);
    expect(reopened).toMatchObject({
      result: "pending",
      roundNo: old.roundNo + 1,
      reopenOfLaunchSubmissionId: old.id,
    });
    const row = await h.prisma.launchSubmission.findUniqueOrThrow({
      where: { id: reopened.launchSubmissionId },
    });
    expect(row).toMatchObject({
      collectionUrl: old.collectionUrl,
      reportedEpisodeCount: old.reportedEpisodeCount,
      actualLaunchDate: old.actualLaunchDate,
      submitActorType: old.submitActorType,
      submitActorId: old.submitActorId,
      submitClient: old.submitClient,
      submittedAt: old.submittedAt,
    });
    expect(
      await h.prisma.approvalRequest.findUnique({ where: { id: row.approvalRequestId } }),
    ).toMatchObject({
      status: "pending",
      requesterStaffId: f.qc.row.id,
      submitActorType: "staff",
      submitActorId: f.qc.row.id,
      submitClient: "admin",
      dedupeKey: `launch_link:${old.launchTaskId}`,
    });
    expect(await h.prisma.deliveryTicket.findUnique({ where: { id: f.id } })).toMatchObject({
      step: "in_service",
    });
    expect(await h.prisma.orderItem.findUnique({ where: { id: f.item.id } })).toMatchObject({
      phase: "live",
      usageStartDate: new Date("2026-01-05"),
      liveEpisodeCount: 2,
    });
    expect(await h.prisma.patrolTask.findUnique({ where: { id: patrol.id } })).toMatchObject({
      status: "void",
    });
    expect(await h.prisma.timer.findUnique({ where: { id: timer.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await h.prisma.followUp.findUnique({ where: { id: follow.id } })).toMatchObject({
      doneAt: now,
      lockVersion: 1,
    });
    expect(
      await h.prisma.statusTransition.findFirst({
        where: { machine: "patrol_task", subjectId: patrol.id },
      }),
    ).toMatchObject({ fromState: "pending", toState: "void", event: "patrol.void" });
    expect(await h.prisma.launchTask.findUnique({ where: { id: old.launchTaskId } })).toMatchObject(
      { isLive: false, wentLiveAt: null, verifiedEpisodeCount: 1, completedAt: null },
    );
    expect(
      await h.prisma.launchSubmission.count({
        where: {
          launchTaskId: old.launchTaskId,
          result: "passed_partial",
          verifiedEpisodeCount: 1,
        },
      }),
    ).toBe(1);
    expect(
      (
        await h.prisma.outboxEvent.findFirstOrThrow({
          where: { eventType: "launch.verify_revoked", aggregateId: old.launchTaskId },
        })
      ).payload,
    ).toEqual({
      v: 1,
      launchTaskId: old.launchTaskId,
      orderItemId: f.item.id,
      isLive: false,
      fromState: "passed",
      toState: "verifying",
      transition: "launch.verify_revoke",
    });
    await expect(
      h.deps.publish.approveLaunch(f.qc.ctx, f.qc.staff, row.id, {
        lockVersion: 0,
        confirm: { roundNo: row.roundNo, reportedEpisodeCount: 2 },
        verifiedEpisodeCount: 2,
        ...(await h.checks("launch.verify")),
      }),
    ).rejects.toMatchObject({ error: "APPROVAL_SELF_FORBIDDEN" });
  });
  it("最后live并发撤销仅一次；清live_at并真正重推order，原审批不撤回", async () => {
    const old = passed[1]!,
      body = bodyOf(old);
    const attempts = await Promise.allSettled([
      service().revoke(f.qc.ctx, f.qc.staff, old.id, body),
      service().revoke(f.qc.ctx, f.qc.staff, old.id, body),
    ]);
    expect(
      attempts.filter((a) => a.status === "fulfilled"),
      attempts.map((a) => (a.status === "rejected" ? String(a.reason) : "fulfilled")).join("\n"),
    ).toHaveLength(1);
    // The winner inserts a new approval while the loser waits on the existing
    // owner graph. Its lock-target revalidation must reject that changed graph.
    expect(attempts.find((a) => a.status === "rejected")).toMatchObject({
      reason: { error: "PRECONDITION_CHANGED" },
    });
    await expect(service().revoke(f.qc.ctx, f.qc.staff, old.id, body)).rejects.toMatchObject({
      error: "STATE_NOT_ALLOWED",
    });
    expect(await h.prisma.deliveryTicket.findUnique({ where: { id: f.id } })).toMatchObject({
      step: "launch_verify",
      liveAt: null,
    });
    expect(await h.prisma.orderItem.findUnique({ where: { id: f.item.id } })).toMatchObject({
      phase: "to_launch",
      usageStartDate: null,
      liveEpisodeCount: 0,
    });
    expect(
      await h.prisma.outboxEvent.count({
        where: { eventType: "order.item.live_revoked", aggregateId: f.item.id },
      }),
    ).toBe(1);
    expect(
      await h.prisma.approvalRequest.findUnique({ where: { id: old.approvalRequestId } }),
    ).toMatchObject({ status: "approved" });
    expect(
      await h.prisma.launchSubmission.count({ where: { reopenOfLaunchSubmissionId: old.id } }),
    ).toBe(1);
    expect(
      await h.prisma.approvalRequest.count({
        where: { dedupeKey: `launch_link:${old.launchTaskId}`, status: "pending" },
      }),
    ).toBe(1);
    expect(
      await h.prisma.statusTransition.count({
        where: { subjectId: old.launchTaskId, event: "launch.verify_revoke" },
      }),
    ).toBe(1);
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: old.launchTaskId, eventType: "launch.verify_revoked" },
      }),
    ).toBe(1);
    expect(
      await h.prisma.auditLog.findFirst({
        where: { targetId: old.launchTaskId, action: "publish.launch_task.verify_revoke" },
      }),
    ).toMatchObject({ reasonText: body.reason });
  });
});

async function reminderInput(date: string) {
  const own = await n.merchant(),
    manager = await n.make.staff({ staffRoleKey: "delivery_manager" });
  const item = await n.make.orderItem({
    dramaOrderId: own.order.id,
    dramaSnapshot: { title: "上线提醒真实短剧" },
    phase: "to_launch",
    agreedLaunchDate: new Date(date),
    usageEndDate: new Date("2027-01-01"),
  });
  const ticket = await n.make.deliveryTicket({
    orderItemId: item.id,
    step: "awaiting_launch",
    deliveredAt: new Date("2026-10-08T00:00:00Z"),
    deliveryManagerId: manager.id,
  });
  const now = n.clock.now(),
    uid = uuidv7();
  // Historical publication inputs isolate the scheduled scanner; the real producer is verified above.
  const account = await h.prisma.channelAccount.create({
    data: {
      id: uuidv7(),
      entityId: own.entity.id,
      storeId: own.store.id,
      platform: "douyin",
      accountName: "提醒账号",
      accountUid: uid,
      accountUidNorm: uid,
      accountType: "none",
      status: "available",
      submittedAt: now,
      verifiedAt: now,
      verifiedByStaffId: manager.id,
      createdAt: now,
      updatedAt: now,
    },
  });
  const task = await h.prisma.launchTask.create({
    data: {
      id: uuidv7(),
      entityId: own.entity.id,
      storeId: own.store.id,
      orderItemId: item.id,
      deliveryTicketId: ticket.id,
      channelAccountId: account.id,
      platform: "douyin",
      reviewStatus: "pending",
      createdAt: now,
      updatedAt: now,
    },
  });
  return { own, manager, item, ticket, task };
}
describe("R2/R6真实扫描聚合", () => {
  it("T-1/T-0门店聚合精确去重，核验中不再发送；09:00前不扫描", async () => {
    n.clock.set(new Date("2026-10-08T00:59:00Z"));
    const r = await reminderInput("2026-10-09");
    await n.service.remindScan({ scheduledFor: n.clock.now() });
    expect(
      await h.prisma.notification.count({ where: { sourceRule: "R2", storeId: r.own.store.id } }),
    ).toBe(0);
    n.clock.set(new Date("2026-10-08T01:00:00Z"));
    await n.service.remindScan({ scheduledFor: n.clock.now() });
    await n.service.remindScan({ scheduledFor: n.clock.now() });
    const messages = await h.prisma.notification.findMany({
      where: { sourceRule: "R2", storeId: r.own.store.id },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      bizType: "store",
      node: "T-1",
      dedupeKey: `launch:${r.own.store.id}:2026-10-09:T-1:${r.own.user.id}`,
    });
    n.clock.set(new Date("2026-10-09T01:00:00Z"));
    await n.service.remindScan({ scheduledFor: n.clock.now() });
    expect(
      await h.prisma.notification.count({
        where: { sourceRule: "R2", storeId: r.own.store.id, node: "T-0" },
      }),
    ).toBe(1);
    await h.prisma.launchTask.update({
      where: { id: r.task.id },
      data: { reviewStatus: "verifying", currentRoundNo: 1 },
    });
    expect(
      await n.tx.run((tx) =>
        launchReminderRule.revalidate!(tx, {
          storeId: r.own.store.id,
          launchDate: "2026-10-09",
          now: n.clock.now(),
        }),
      ),
    ).toEqual({ valid: false });
  });
  it("R6按人按日一条、空biz与真实items；非工作日仅约定日次日，换负责人使旧发送失效", async () => {
    n.clock.set(new Date("2026-10-10T01:00:00Z"));
    await h.prisma.workCalendarDay.upsert({
      where: { day: new Date("2026-10-10") },
      create: {
        day: new Date("2026-10-10"),
        isWorkday: false,
        kind: "weekend",
        calendarVersion: 1,
      },
      update: { isWorkday: false, kind: "weekend" },
    });
    const r = await reminderInput("2026-10-09"),
      skipped = await reminderInput("2026-10-08");
    await n.service.remindScan({ scheduledFor: n.clock.now() });
    await n.service.remindScan({ scheduledFor: n.clock.now() });
    const messages = await h.prisma.notification.findMany({
      where: { sourceRule: "R6", staffId: r.manager.id },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      bizType: null,
      bizId: null,
      dedupeKey: `launch_overdue:${r.manager.id}:2026-10-10`,
      node: "N0",
      vars: { items: [{ orderItemId: r.item.id, overdueDays: 1, reason: "merchant" }] },
    });
    expect(
      await h.prisma.notification.count({
        where: { sourceRule: "R6", staffId: skipped.manager.id },
      }),
    ).toBe(0);
    await h.prisma.deliveryTicket.update({
      where: { id: r.ticket.id },
      data: { deliveryManagerId: skipped.manager.id },
    });
    expect(
      await n.tx.run((tx) =>
        overdueLaunchReminderRule.revalidate!(tx, {
          staffId: r.manager.id,
          date: "2026-10-10",
          now: n.clock.now(),
        }),
      ),
    ).toEqual({ valid: false });
  });
});
