import { afterAll, beforeAll, expect, it } from "vitest";
import {
  assembleForTest,
  createFakeProviders,
  createPatrolTestRuntime,
  createPatrolTestSubject,
  createTestWorkerServices,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { runInvariants } from "./invariants/run.js";
import { claimTimers } from "../timers/index.js";
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
afterAll(async () => {
  await stack?.runtime.close();
});
it("真实worker周任务与三日timer均经认领执行；两个实例隔离，关闭后不再执行", async () => {
  const prisma = await db.prisma(),
    h = await createPatrolTestSubject(stack.runtime, prisma),
    live = await h.launch();
  const build = () =>
    createTestWorkerServices({
      prisma,
      clock: stack.clock,
      assembly: assembleForTest({ entry: "worker" }),
      providers: createFakeProviders({ clock: stack.clock }),
      channel: { enqueue: async () => {}, downForMs: () => 0 },
    });
  const first = build(),
    second = build();
  try {
    expect(
      stack.runtime.assembly.timerHandlers.filter((r) => r.kind === "patrol.followup"),
    ).toHaveLength(1);
    expect(
      stack.runtime.assembly.recurringJobs.filter((r) => r.kind === "patrol.weekly_generate"),
    ).toHaveLength(1);
    await stack.runtime.tx.run((tx) => stack.runtime.timers.ensureRecurring(tx, stack.clock.now()));
    const weekly = await prisma.timer.findFirstOrThrow({
      where: { kind: "patrol.weekly_generate", fireAt: { lte: stack.clock.now() } },
    });
    const claimed = (
      await stack.runtime.tx.run((tx) =>
        claimTimers(tx, stack.runtime.timers.registry, stack.clock.now()),
      )
    ).claimed;
    const weekRef = claimed.find((r) => r.timerId === weekly.id);
    expect(weekRef).toBeDefined();
    expect(await first.runTimer(weekRef!)).toBe("fired");
    expect(await first.runTimer(weekRef!)).toBe("stale");
    const patrol = await prisma.patrolTask.findFirstOrThrow({
      where: { launchTaskId: live.taskId },
    });
    expect(patrol.source).toBe("weekly_sample");
    const kind = await prisma.dictItem.findFirstOrThrow({
      where: { dictTypeKey: "patrol_issue", isEnabled: true },
    });
    await h.patrol.decide(h.adminCtx, h.staff, patrol.id, "abnormal", {
      abnormalKindCode: kind.code,
      note: "真实worker三日跟进",
      evidenceFileIds: [await h.evidence()],
    });
    stack.clock.advance(3 * 86400000);
    const timer = await prisma.timer.findFirstOrThrow({
      where: { kind: "patrol.followup", subjectId: patrol.id },
    });
    const followRef = (
      await stack.runtime.tx.run((tx) =>
        claimTimers(tx, stack.runtime.timers.registry, stack.clock.now()),
      )
    ).claimed.find((r) => r.timerId === timer.id);
    expect(followRef).toBeDefined();
    await first.closeOrder!();
    await expect(
      stack.runtime.tx.run((tx) =>
        first.assembly.timerHandler("patrol.followup")!.handle(tx, {
          id: timer.id,
          kind: timer.kind,
          subjectType: "patrol_task",
          subjectId: patrol.id,
          payload: null,
        }),
      ),
    ).rejects.toThrow("未绑定或已关闭");
    await expect(
      stack.runtime.tx.run((tx) =>
        first.assembly.invariant("timers.I7")!.run!(tx, {}, { now: stack.clock.now() }),
      ),
    ).rejects.toThrow("未绑定或已关闭");
    expect(await prisma.followUp.count({ where: { subjectId: patrol.id } })).toBe(0);
    expect(
      await stack.runtime.tx.run((tx) =>
        second.assembly.invariant("timers.I7")!.run!(tx, {}, { now: stack.clock.now() }),
      ),
    ).toEqual([]);
    expect(await second.runTimer(followRef!)).toBe("fired");
    expect(await second.runTimer(followRef!)).toBe("stale");
    expect(await prisma.followUp.findMany({ where: { subjectId: patrol.id } })).toEqual([
      expect.objectContaining({
        ownerStaffId: h.manager.id,
        actorType: "system",
        channel: "system",
      }),
    ]);
    await second.closeOrder!();
    await expect(
      stack.runtime.tx.run((tx) =>
        second.assembly.invariant("timers.I7")!.run!(tx, {}, { now: stack.clock.now() }),
      ),
    ).rejects.toThrow("未绑定或已关闭");
    // API owns its own live scope after both worker scopes are closed.
    expect(
      await h.patrol.decide(h.adminCtx, h.staff, patrol.id, "recover", {
        ...(await h.checks("patrol.check")),
        evidenceFileIds: [await h.evidence()],
      }),
    ).toMatchObject({ status: "recovered" });
  } finally {
    for (const worker of [second, first]) {
      await worker.closeOrder?.();
      await worker.closeNotify();
      await worker.closeDocs();
      await worker.closeStaff?.();
      await worker.closeProfile?.();
      worker.closeInvitations?.();
      worker.closeApproval?.();
      worker.closeBillingTimers?.();
      worker.closePublish?.();
      worker.closeDelivery?.();
      await worker.closeAnalytics?.();
      worker.closeWebhooks?.();
      worker.closeMediaJobs?.();
      await worker.closeMediaDrivers?.();
      await worker.closeStorageDrivers?.();
    }
  }
});

it("真实巡检不变量检测归属错误与过期作废，分别落未解决告警和自愈告警", async () => {
  stack.clock.set(new Date("2026-01-05T04:00:00Z"));
  const prisma = await db.prisma(),
    h = await createPatrolTestSubject(stack.runtime, prisma),
    live = await h.launch(),
    other = await h.launch();
  const id = (await h.patrol.create(h.adminCtx, h.staff, { launchTaskId: live.taskId })).patrolTask
    .patrolTaskId;
  const check = (code: string) =>
    runInvariants(
      { tx: stack.runtime.tx, assembly: stack.runtime.assembly, clock: stack.clock },
      { mode: "full", trigger: "manual", codes: [code] },
    );
  // Deliberate relationship corruption proves I14 observes stored facts, not its own writer.
  await prisma.patrolTask.update({ where: { id }, data: { orderItemId: other.itemId } });
  const ownership = await check("publish.I14");
  expect(ownership).toMatchObject({
    status: "succeeded",
    checksRun: 1,
    violationsFound: 1,
    created: 1,
  });
  expect(
    await prisma.invariantViolation.findFirst({ where: { code: "publish.I14", subjectId: id } }),
  ).toMatchObject({
    detail: expect.objectContaining({ entityId: h.merchant.entity.id }),
    module: "publish",
    autoHealedAt: null,
    resolvedAt: null,
  });
  await prisma.patrolTask.update({ where: { id }, data: { orderItemId: live.itemId } });
  expect(await check("publish.I14")).toMatchObject({ violationsFound: 0 });
  const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: live.itemId } });
  stack.clock.set(new Date(item.usageEndDate.getTime() + 2 * 86400000));
  expect(await check("publish.I15")).toMatchObject({
    status: "succeeded",
    checksRun: 1,
    violationsFound: 1,
  });
  expect(
    await prisma.invariantViolation.findFirst({ where: { code: "publish.I15", subjectId: id } }),
  ).toMatchObject({
    detail: expect.objectContaining({ entityId: h.merchant.entity.id }),
    module: "publish",
    autoHealedAt: stack.clock.now(),
    resolvedAt: null,
  });
  expect(await prisma.patrolTask.findUnique({ where: { id } })).toMatchObject({ status: "void" });
  expect(await check("publish.I15")).toMatchObject({ violationsFound: 0 });
});
