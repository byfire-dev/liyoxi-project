import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTxRunner, uuidv7 } from "../kernel/index.js";
import { buildWorkerServices } from "../ops/index.js";
import { armRecurringSlot, claimTimers } from "../timers/index.js";
import {
  assembleForTest,
  createClock,
  createProviderHarness,
  useSeededDatabase,
} from "../testing/index.js";
import { createAnalyticsJobs, runScheduledDedupPurge } from "./jobs.js";

const db = useSeededDatabase("services");
const clock = createClock(new Date("2026-10-08T04:00:00Z"));
let prisma: PrismaClient, worker: ReturnType<typeof buildWorkerServices>;
const refs: { timerId: string; kind: string; dispatchNo: number }[] = [];
beforeAll(async () => {
  prisma = await db.prisma();
  worker = buildWorkerServices({
    appEnv: "test",
    prisma,
    clock,
    assembly: assembleForTest({ entry: "worker" }),
    providers: createProviderHarness({ clock }).providers,
    channel: { enqueue: async () => undefined, downForMs: () => 0 },
  });
}, 120_000);
afterAll(async () => {
  await worker?.closeAnalytics?.();
  worker?.closeWebhooks?.();
  worker?.closeDelivery?.();
  worker?.closePublish?.();
  worker?.closeBillingTimers?.();
  worker?.closeOrder?.();
});
it("真实worker装配与job认领执行：每日04:10/P3，按执行clock8天cutoff多批清理、结果与重放", async () => {
  const job = worker.assembly.recurringJob("analytics.dedup_purge");
  expect(job).toMatchObject({
    kind: "analytics.dedup_purge",
    module: "analytics",
    schedule: { every: "day", at: "04:10" },
    mode: "job",
    missSeverity: "P3",
    catchUp: true,
  });
  const cutoff = new Date(clock.now().getTime() - 8 * 86_400_000),
    edgeId = uuidv7();
  const old = Array.from({ length: 5_001 }, () => ({
    eventId: uuidv7(),
    receivedAt: new Date(cutoff.getTime() - 1),
  }));
  await prisma.analyticsEventDedup.createMany({
    data: [...old, { eventId: edgeId, receivedAt: cutoff }],
  });
  const tx = createTxRunner({ prisma, appEnv: "test" });
  // 故意是旧计划格；处理器不能用计划时刻替代当前执行时刻。
  await tx.run((handle) =>
    armRecurringSlot(handle, "analytics.dedup_purge", new Date("2026-10-01T20:10:00Z")),
  );
  const claimed = await tx.run((handle) =>
    claimTimers(handle, worker.timers.registry, clock.now()),
  );
  refs.push(...claimed.claimed);
  expect(refs).toHaveLength(1);
  expect(await worker.runTimer(refs[0]!)).toBe("fired");
  expect(await prisma.analyticsEventDedup.count()).toBe(1);
  expect(
    await prisma.analyticsEventDedup.findUnique({ where: { eventId: edgeId } }),
  ).not.toBeNull();
  expect(await prisma.timer.findUnique({ where: { id: refs[0]!.timerId } })).toMatchObject({
    status: "fired",
    result: { deleted: 5_001, batches: 2 },
  });
  expect(await worker.runTimer(refs[0]!)).toBe("stale");
  expect(await prisma.analyticsEventDedup.count()).toBe(1);
}, 120_000);
it("job取消在下一短TX前收手；owned关闭只清自己，旧关闭不移除新clock", async () => {
  const calls: string[] = [];
  const base = assembleForTest({ entry: "worker" });
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const providers = createProviderHarness({ clock }).providers;
  const first = createAnalyticsJobs(base, {
    tx,
    appEnv: "test",
    storage: () => providers.storage,
    clock: {
      now: () => {
        calls.push("first");
        return clock.now();
      },
    },
  });
  const second = createAnalyticsJobs(base, {
    tx,
    appEnv: "test",
    storage: () => providers.storage,
    clock: {
      now: () => {
        calls.push("second");
        return clock.now();
      },
    },
  });
  await first.close();
  const signal = new AbortController();
  signal.abort();
  let transactions = 0;
  await expect(
    second.assembly.recurringJob("analytics.dedup_purge")!.run({
      scheduledFor: clock.now(),
      signal: signal.signal,
      runTx: async () => {
        transactions++;
        throw new Error("不应进入");
      },
    }),
  ).rejects.toThrow("已取消");
  expect(transactions).toBe(0);
  expect(calls).toEqual(["second"]);
  await second.close();
  const cancelled = {
    scheduledFor: clock.now(),
    runTx: async () => {
      throw new Error("不应进入");
    },
  };
  await expect(
    second.assembly.recurringJob("analytics.dedup_purge")!.run(cancelled),
  ).rejects.toThrow("已经关闭");
  await expect(runScheduledDedupPurge()).rejects.toThrow("尚未绑定");
});
