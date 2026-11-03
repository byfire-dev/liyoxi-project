import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { z } from "@liyoxi/contract";
import { fileRefTypePort } from "../kernel/index.js";
import {
  createPatrolTestRuntime,
  createPatrolTestSubject,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { findPublishViolations } from "./invariants.js";
import { patrolOwnershipViolations, patrolObsoleteViolations } from "./patrol-invariants.js";
const db = useSeededDatabase("services", { max: 2 }),
  redis = useTestRedis();
let stack: ReturnType<typeof createPatrolTestRuntime>;
beforeAll(async () => {
  stack = createPatrolTestRuntime({
    databaseUrl: await db.url(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: redis.prefix,
  });
});
beforeEach(() => stack.clock.set(new Date("2026-01-05T04:00:00Z")));
afterAll(async () => {
  await stack?.runtime.close();
});
const subject = async () => createPatrolTestSubject(stack.runtime, await db.prisma());
async function abnormal(h: Awaited<ReturnType<typeof subject>>) {
  const live = await h.launch(),
    made = await h.patrol.create(h.adminCtx, h.staff, { launchTaskId: live.taskId });
  const kind = await h.prisma.dictItem.findFirstOrThrow({
    where: { dictTypeKey: "patrol_issue", isEnabled: true },
  });
  const fileId = await h.evidence();
  await h.patrol.decide(h.adminCtx, h.staff, made.patrolTask.patrolTaskId, "abnormal", {
    abnormalKindCode: kind.code,
    note: "真实人工巡检证据",
    evidenceFileIds: [fileId],
  });
  return { ...live, id: made.patrolTask.patrolTaskId, fileId };
}
it("真实上线producer推导订单/工单后才建巡检，两个事务只一份在办任务与历史事件", async () => {
  const h = await subject(),
    live = await h.launch();
  expect(await h.prisma.deliveryTicket.findUnique({ where: { id: live.ticketId } })).toMatchObject({
    step: "in_service",
  });
  expect(await h.prisma.orderItem.findUnique({ where: { id: live.itemId } })).toMatchObject({
    phase: "live",
    liveEpisodeCount: 1,
  });
  expect(await h.prisma.dramaOrder.findUnique({ where: { id: live.orderId } })).toMatchObject({
    status: "live",
  });
  const results = await Promise.all(
    [0, 1].map(() => h.patrol.create(h.adminCtx, h.staff, { launchTaskId: live.taskId })),
  );
  expect(results.map((r) => r.isNew).sort()).toEqual([false, true]);
  expect(new Set(results.map((r) => r.patrolTask.patrolTaskId)).size).toBe(1);
  const id = results[0]!.patrolTask.patrolTaskId;
  expect(
    await h.prisma.statusTransition.count({ where: { subjectId: id, event: "patrol.create" } }),
  ).toBe(1);
  expect(
    await h.prisma.outboxEvent.count({ where: { aggregateId: id, eventType: "patrol.created" } }),
  ).toBe(1);
  for (const code of ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9"])
    expect(await h.runtime.tx.run((tx) => findPublishViolations(tx, code)), code).toEqual([]);
  expect(await h.runtime.tx.run(patrolOwnershipViolations)).toEqual([]);
  expect(await h.runtime.tx.run((tx) => patrolObsoleteViolations(tx, stack.clock.now()))).toEqual(
    [],
  );
});
it("周生成实际候选与手动批次复用、重跑零重复，批次总数和范围计数分别准确", async () => {
  const h = await subject(),
    a = await h.launch(),
    b = await h.launch();
  const manual = await h.patrol.create(h.adminCtx, h.staff, { launchTaskId: a.taskId });
  const before = await h.prisma.patrolBatch.findFirstOrThrow({
    where: { weekStartDate: new Date("2026-01-05") },
  });
  const handler = h.runtime.assembly.recurringJob("patrol.weekly_generate")!;
  const result = await h.runtime.tx.run((tx) =>
    handler.run({ tx, scheduledFor: stack.clock.now() }),
  );
  expect(result).toMatchObject({ generated: true });
  expect(await h.prisma.patrolTask.count({ where: { launchTaskId: a.taskId } })).toBe(1);
  const selected = await h.prisma.patrolTask.findFirstOrThrow({
    where: { launchTaskId: b.taskId },
  });
  expect(selected).toMatchObject({ source: "weekly_sample", patrolBatchId: before.id });
  const snapshot = await h.prisma.patrolTask.findMany({ orderBy: { id: "asc" } });
  expect(
    await h.runtime.tx.run((tx) => handler.run({ tx, scheduledFor: stack.clock.now() })),
  ).toMatchObject({ generated: false });
  expect(await h.prisma.patrolTask.findMany({ orderBy: { id: "asc" } })).toEqual(snapshot);
  const summary = await h.patrol.summary(h.staff, { storeId: h.merchant.store.id });
  expect(summary).toMatchObject({
    all: 2,
    pending: 2,
    normal: 0,
    batch: { patrolBatchId: before.id },
  });
  expect(manual.patrolTask.source).toBe("manual");
});
it("正常结论须真实清单和本店证据，失败整笔零写，成功保留三年引用", async () => {
  const h = await subject(),
    live = await h.launch();
  const id = (await h.patrol.create(h.adminCtx, h.staff, { launchTaskId: live.taskId })).patrolTask
    .patrolTaskId;
  const check = await h.checks("patrol.check"),
    fileId = await h.evidence();
  await expect(
    h.patrol.decide(h.adminCtx, h.staff, id, "normal", {
      ...check,
      results: [],
      evidenceFileIds: [fileId],
    }),
  ).rejects.toMatchObject({ error: "CHECKLIST_NOT_PASSED" });
  expect(await h.prisma.patrolTask.findUnique({ where: { id } })).toMatchObject({
    status: "pending",
    evidenceFileIds: [],
  });
  expect(await h.prisma.fileRef.count({ where: { refType: "patrol_task", refId: id } })).toBe(0);
  const foreign = await subject(),
    foreignFile = await foreign.evidence();
  await expect(
    h.patrol.decide(h.adminCtx, h.staff, id, "normal", {
      ...check,
      evidenceFileIds: [foreignFile],
    }),
  ).rejects.toMatchObject({ error: "FILE_NOT_USABLE" });
  const normal = await h.patrol.decide(h.adminCtx, h.staff, id, "normal", {
    ...check,
    evidenceFileIds: [fileId],
  });
  expect(normal).toMatchObject({ status: "normal", evidenceFileIds: [fileId] });
  expect(await h.prisma.launchTask.findUnique({ where: { id: live.taskId } })).toMatchObject({
    lastPatrolResult: "normal",
    lastPatrolledAt: stack.clock.now(),
  });
  const ref = await h.prisma.fileRef.findFirstOrThrow({ where: { refId: id, fileId } });
  // Active evidence is never purgeable: retention dates only apply after release.
  expect(ref).toMatchObject({ state: "live", keepUntil: null, releasedAt: null });
  expect(await h.prisma.fileObject.findUnique({ where: { id: fileId } })).toMatchObject({
    purgeAfter: null,
  });
  const role = h.runtime.assembly.portEntries(fileRefTypePort).get("patrol_task")!.roles.evidence!;
  expect(role.retentionDays).toBe(1095);
  expect(await h.runtime.tx.run((tx) => role.canRelease!(tx, id))).toBe(false);
  await expect(
    h.runtime.tx.run((tx) =>
      h.runtime.media.release(tx, {
        fileId,
        refType: "patrol_task",
        refId: id,
        role: "evidence",
        entityId: h.merchant.entity.id,
        storeId: h.merchant.store.id,
        keepUntil: stack.clock.now(),
      }),
    ),
  ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
  stack.clock.advance(1);
  const again = await h.patrol.create(h.adminCtx, h.staff, { launchTaskId: live.taskId });
  expect(again).toMatchObject({
    isNew: true,
    patrolTask: { previousPatrol: { patrolTaskId: id, status: "normal" } },
  });
});
it("异常→催办→恢复走真实通知消费、追加证据，旧异常与旧M事件失效且不改账号", async () => {
  const h = await subject(),
    target = await abnormal(h);
  const event = await h.prisma.outboxEvent.findFirstOrThrow({
    where: { aggregateId: target.id, eventType: "patrol.abnormal" },
  });
  const delivered = {
    id: event.id,
    type: event.eventType,
    payload: z.record(z.string(), z.unknown()).parse(event.payload),
  };
  expect(await h.runtime.tx.run((tx) => h.runtime.notify.onEvent(tx, delivered))).toBe(1);
  expect(await h.runtime.tx.run((tx) => h.runtime.notify.onEvent(tx, delivered))).toBe(0);
  await h.patrol.remind(h.adminCtx, h.staff, target.id);
  await expect(h.patrol.remind(h.adminCtx, h.staff, target.id)).rejects.toMatchObject({
    error: "REMINDED_TODAY",
  });
  const manual = await h.prisma.outboxEvent.findFirstOrThrow({
    where: {
      eventType: "manual_reminder.sent",
      payload: { path: ["subjectId"], equals: target.id },
    },
  });
  const reminder = {
    id: manual.id,
    type: manual.eventType,
    payload: z.record(z.string(), z.unknown()).parse(manual.payload),
  };
  expect(await h.runtime.tx.run((tx) => h.runtime.notify.onEvent(tx, reminder))).toBe(1);
  const check = await h.checks("patrol.check"),
    fileId = await h.evidence();
  await expect(
    h.patrol.decide(h.adminCtx, h.staff, target.id, "recover", {
      ...check,
      evidenceFileIds: [target.fileId],
    }),
  ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
  expect(
    await h.patrol.decide(h.adminCtx, h.staff, target.id, "recover", {
      ...check,
      evidenceFileIds: [fileId],
    }),
  ).toMatchObject({ status: "recovered", evidenceFileIds: [target.fileId, fileId] });
  expect(await h.runtime.tx.run((tx) => h.runtime.notify.onEvent(tx, delivered))).toBe(0);
  expect(await h.runtime.tx.run((tx) => h.runtime.notify.onEvent(tx, reminder))).toBe(0);
  const recovered = await h.prisma.outboxEvent.findFirstOrThrow({
    where: { aggregateId: target.id, eventType: "patrol.recovered" },
  });
  expect(
    await h.runtime.tx.run((tx) =>
      h.runtime.notify.onEvent(tx, {
        id: recovered.id,
        type: recovered.eventType,
        payload: z.record(z.string(), z.unknown()).parse(recovered.payload),
      }),
    ),
  ).toBe(1);
  expect(
    await h.prisma.channelAccount.findUnique({ where: { id: target.accountId } }),
  ).toMatchObject({ status: "available" });
  expect(
    await h.prisma.timer.count({
      where: { subjectId: target.id, kind: "patrol.followup", status: { not: "cancelled" } },
    }),
  ).toBe(0);
  expect(
    await h.prisma.fileRef.count({ where: { refType: "patrol_task", refId: target.id } }),
  ).toBe(2);
});
it("使用期结束的真实不变量自愈保留证据，已失效巡检禁止晚到写入", async () => {
  const h = await subject(),
    target = await abnormal(h),
    old = await h.prisma.patrolTask.findUniqueOrThrow({ where: { id: target.id } });
  const item = await h.prisma.orderItem.findUniqueOrThrow({ where: { id: target.itemId } });
  stack.clock.set(new Date(item.usageEndDate.getTime() + 2 * 86400000));
  const invariant = h.runtime.assembly.invariant("publish.I15")!;
  const found = await h.runtime.tx.run((tx) => invariant.run!(tx, {}, { now: stack.clock.now() }));
  expect(found).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        subject: { type: "patrol_task", id: target.id },
        healed: expect.any(Object),
      }),
    ]),
  );
  expect(await h.prisma.patrolTask.findUnique({ where: { id: target.id } })).toMatchObject({
    status: "void",
    evidenceFileIds: old.evidenceFileIds,
    foundAt: old.foundAt,
  });
  await expect(h.patrol.remind(h.adminCtx, h.staff, target.id)).rejects.toMatchObject({
    error: "PATROL_NOT_ELIGIBLE",
  });
  expect(await h.runtime.tx.run((tx) => patrolObsoleteViolations(tx, stack.clock.now()))).toEqual(
    [],
  );
});
it("timers.I7修复未到期缺登记与已恢复孤儿，保留原截止及失败退避并重复零写", async () => {
  const h = await subject(),
    target = await abnormal(h);
  const run = () =>
    h.runtime.tx.run((tx) =>
      h.runtime.assembly.invariant("timers.I7")!.run!(tx, {}, { now: stack.clock.now() }),
    );
  const original = await h.prisma.timer.findFirstOrThrow({
    where: { kind: "patrol.followup", subjectId: target.id },
  });
  // Corrupt only the timer fixture to represent a missing registration; no business success is seeded.
  await h.runtime.tx.run((tx) =>
    h.runtime.timers.cancel(tx, {
      subject: { type: "patrol_task", id: target.id },
      kinds: ["patrol.followup"],
    }),
  );
  expect(await run()).toEqual([
    expect.objectContaining({
      subject: { type: "patrol_task", id: target.id },
      healed: expect.any(Object),
    }),
  ]);
  const repaired = await h.prisma.timer.findFirstOrThrow({
    where: { kind: "patrol.followup", subjectId: target.id, status: "scheduled" },
  });
  expect(repaired.fireAt).toEqual(original.fireAt);
  const retryAt = new Date(stack.clock.now().getTime() + 60000);
  await h.prisma.timer.update({
    where: { id: repaired.id },
    data: { attempts: 1, retryAt, lastError: "受控技术退避" },
  });
  expect(await run()).toEqual([]);
  expect(await h.prisma.timer.findUnique({ where: { id: repaired.id } })).toMatchObject({
    attempts: 1,
    retryAt,
    lastError: "受控技术退避",
  });
  await h.patrol.decide(h.adminCtx, h.staff, target.id, "recover", {
    ...(await h.checks("patrol.check")),
    evidenceFileIds: [await h.evidence()],
  });
  // Public timer writer injects an orphan, while the recovered business history remains untouched.
  const orphan = await h.runtime.tx.run((tx) =>
    h.runtime.timers.arm(tx, {
      kind: "patrol.followup",
      subject: { type: "patrol_task", id: target.id },
      key: `patrol.followup:patrol_task:${target.id}`,
      fireAt: original.fireAt,
      entityId: h.merchant.entity.id,
      storeId: h.merchant.store.id,
    }),
  );
  expect(await run()).toEqual([
    expect.objectContaining({
      subject: { type: "timer", id: orphan.id },
      detail: { kind: "patrol.followup", orphan: true },
      healed: expect.any(Object),
    }),
  ]);
  expect(await run()).toEqual([]);
  expect(
    await h.prisma.timer.count({
      where: {
        kind: "patrol.followup",
        subjectId: target.id,
        status: { in: ["scheduled", "dispatched"] },
      },
    }),
  ).toBe(0);
});
