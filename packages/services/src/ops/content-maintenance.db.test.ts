import { expect, it } from "vitest";
import { createTxRunner } from "../kernel/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createProviderHarness,
  useSeededDatabase,
} from "../testing/index.js";
import { buildWorkerServices } from "./worker.js";

const db = useSeededDatabase("services");

it("实际 worker 的小时统计处理器把真实上线订单项计为非零，并覆盖旧零值", async () => {
  const prisma = await db.prisma();
  const clock = createClock();
  const make = createFactories({ db: prisma, clock });
  const drama = await make.drama();
  const item = await make.orderItem({ dramaId: drama.id, phase: "live" });
  await prisma.dramaStat.create({
    data: {
      dramaId: drama.id,
      orders30d: 0,
      ordersMtd: 0,
      liveItems: 0,
      refreshedAt: clock.now(),
      createdAt: clock.now(),
      updatedAt: clock.now(),
    },
  });
  const worker = buildWorkerServices({
    appEnv: "test",
    prisma,
    clock,
    assembly: assembleForTest({ entry: "worker" }),
    providers: createProviderHarness({ clock }).providers,
    channel: { enqueue: async () => {}, downForMs: () => 0 },
  });
  try {
    const job = worker.assembly.recurringJob("content.stat_refresh");
    expect(job).toBeDefined();
    expect(job!.schedule).toEqual({ every: "hour" });
    const tx = createTxRunner({ prisma, appEnv: "test" });
    await job!.run({
      scheduledFor: clock.now(),
      signal: new AbortController().signal,
      runTx: tx.run,
    });
    expect(await prisma.dramaStat.findUnique({ where: { dramaId: drama.id } })).toMatchObject({
      orders30d: 1,
      ordersMtd: 1,
      liveItems: 1,
    });
    clock.advance(40 * 86400000);
    await prisma.orderItem.update({
      where: { id: item.id },
      data: { phase: "ended", phaseChangedAt: clock.now(), updatedAt: clock.now() },
    });
    await job!.run({
      scheduledFor: clock.now(),
      signal: new AbortController().signal,
      runTx: tx.run,
    });
    expect(await prisma.dramaStat.findUnique({ where: { dramaId: drama.id } })).toMatchObject({
      orders30d: 0,
      ordersMtd: 0,
      liveItems: 0,
    });
  } finally {
    await worker.shutdownMediaJobs?.();
    await worker.closeNotify();
    await worker.closeAnalytics?.();
    await worker.closeStaff?.();
    await worker.closeSmsHealth?.();
    worker.closeMediaJobs?.();
    worker.closeWebhooks?.();
    worker.closeOrder?.();
    worker.closeBillingTimers?.();
    worker.closeDelivery?.();
    worker.closePublish?.();
    await Promise.all([worker.closeMediaDrivers?.(), worker.closeStorageDrivers?.()]);
  }
}, 60000);
