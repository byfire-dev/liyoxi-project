import { afterAll, beforeAll, expect, it } from "vitest";
import { buildWorkerServices } from "@liyoxi/services";
import type { TxRunner } from "@liyoxi/services";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  createSampleEvents,
  fakeKeyEnv,
  useSeededDatabase,
} from "@liyoxi/services/testing";

const db = useSeededDatabase("worker"),
  clock = createClock();
let prisma: Awaited<ReturnType<typeof db.prisma>>,
  worker: ReturnType<typeof buildWorkerServices>,
  make: ReturnType<typeof createFactories>,
  tx: TxRunner;
beforeAll(async () => {
  prisma = await db.prisma();
  tx = createSampleEvents(prisma, { registrations: [] }).tx;
  make = createFactories({ db: prisma, clock });
  worker = buildWorkerServices({
    appEnv: "test",
    prisma,
    clock,
    assembly: assembleForTest({ entry: "worker" }),
    providers: createFakeProviders({ clock }),
    keys: fakeKeyEnv(),
    channel: { enqueue: async () => {}, downForMs: () => 0 },
  });
}, 180000);
afterAll(async () => {
  await worker?.shutdownMediaJobs?.();
  await worker?.closeNotify();
  await worker?.closeAnalytics?.();
  await worker?.closeStaff?.();
  await worker?.closeSmsHealth?.();
  worker?.closeMediaJobs?.();
  worker?.closeWebhooks?.();
  worker?.closeOrder?.();
  worker?.closeBillingTimers?.();
  worker?.closeDelivery?.();
  worker?.closePublish?.();
  await Promise.all([worker?.closeMediaDrivers?.(), worker?.closeStorageDrivers?.()]);
});

it("实际worker只登记一份02:30归档与小时统计，缺失租约事务能力拒绝执行", async () => {
  const archive = worker.assembly.recurringJob("content.archive_sweep")!,
    stats = worker.assembly.recurringJob("content.stat_refresh")!;
  expect(archive.schedule).toEqual({ every: "day", at: "02:30" });
  expect(stats.schedule).toEqual({ every: "hour" });
  for (const job of [archive, stats]) {
    expect(worker.assembly.recurringJobs.filter((v) => v.kind === job.kind)).toHaveLength(1);
    await expect(job.run({ scheduledFor: clock.now() })).rejects.toThrow("leased runTx");
  }
});

it("真实订单项小时统计非零；失租后的短事务不写下一页统计", async () => {
  const drama = await make.drama(),
    item = await make.orderItem({ dramaId: drama.id, phase: "live" });
  const job = worker.assembly.recurringJob("content.stat_refresh")!;
  await job.run({ scheduledFor: clock.now(), runTx: tx.run });
  expect(await prisma.dramaStat.findUnique({ where: { dramaId: drama.id } })).toMatchObject({
    orders30d: 1,
    ordersMtd: 1,
    liveItems: 1,
  });
  await prisma.orderItem.update({
    where: { id: item.id },
    data: { phase: "ended", phaseChangedAt: clock.now() },
  });
  const controller = new AbortController();
  let calls = 0;
  const losingLease: TxRunner["run"] = (fn) =>
    tx.run(async (t) => {
      const result = await fn(t);
      if (++calls === 1) controller.abort(new Error("test lease lost after page read"));
      return result;
    });
  await expect(
    job.run({ scheduledFor: clock.now(), signal: controller.signal, runTx: losingLease }),
  ).rejects.toThrow("lease lost");
  expect(
    (await prisma.dramaStat.findUniqueOrThrow({ where: { dramaId: drama.id } })).liveItems,
  ).toBe(1);
});

it("一剧事务失败回滚后仍处理下一剧；最终任务明确失败，不伪报整批成功", async () => {
  const rows = await Promise.all([
    make.drama({ status: "delisted" }),
    make.drama({ status: "delisted" }),
  ]);
  for (const row of rows)
    await prisma.dramaCopyright.create({
      data: {
        dramaId: row.id,
        licenseStartDate: new Date("2025-01-01Z"),
        licenseEndDate: new Date("2025-12-31Z"),
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
  rows.sort((a, b) => a.id.localeCompare(b.id));
  let calls = 0;
  const fault: TxRunner["run"] = (fn) =>
    tx.run(async (t) => {
      const result = await fn(t);
      if (++calls === 2) throw new Error("controlled precommit failure");
      return result;
    });
  await expect(
    worker.assembly
      .recurringJob("content.archive_sweep")!
      .run({ scheduledFor: clock.now(), runTx: fault }),
  ).rejects.toThrow("failed 1 subjects");
  expect(
    (await prisma.drama.findUniqueOrThrow({ where: { id: rows[0]!.id } })).archivedAt,
  ).toBeNull();
  expect((await prisma.drama.findUniqueOrThrow({ where: { id: rows[1]!.id } })).archivedAt).toEqual(
    clock.now(),
  );
  expect(
    await prisma.auditLog.count({
      where: { targetId: rows[0]!.id, action: "content.drama.archive" },
    }),
  ).toBe(0);
});

it("已关闭worker的维护闭包不退回另一个scope，也不继续写库", async () => {
  await worker.closeStaff?.();
  await expect(
    worker.assembly
      .recurringJob("content.stat_refresh")!
      .run({ scheduledFor: clock.now(), runTx: tx.run }),
  ).rejects.toThrow("已经关闭");
});
