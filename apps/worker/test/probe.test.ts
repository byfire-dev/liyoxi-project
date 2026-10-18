import { expect, it, vi } from "vitest";
import { buildWorkerServices, createQueueChannel } from "@liyoxi/services";
import {
  assembleForTest,
  createClock,
  useSeededDatabase,
  useTestRedis,
} from "@liyoxi/services/testing";
import { DOMAIN_LOOPS } from "../src/domain-loops.js";
import { silentLogger } from "../src/log.js";
import { createWorkerRuntime, QUEUE_CONCURRENCY } from "../src/runtime.js";
import type { WorkerQueue } from "../src/runtime.js";

const db = useSeededDatabase("worker", { max: 1 }),
  redis = useTestRedis();
it("正式probe循环真实写完成心跳，worker关闭探针与备份且借用池仍可用", async () => {
  const prisma = await db.prisma(),
    clock = createClock(new Date("2026-01-05T00:00:00Z"));
  await redis.flush();
  const channel = createQueueChannel({
    redisUrl: process.env.REDIS_URL!,
    prefix: `${redis.prefix}bull`,
  });
  await prisma.$executeRawUnsafe(`INSERT INTO worker_lease(name,holder,holder_version,acquired_at,heartbeat_at)
    VALUES('primary','node-a:test','test',clock_timestamp(),clock_timestamp())`);
  const queues = Object.keys(QUEUE_CONCURRENCY) as WorkerQueue[],
    observed = new Set<string>();
  let unavailable = false;
  const services = buildWorkerServices({
    appEnv: "test",
    prisma,
    clock,
    channel: {
      ...channel,
      observe: async (queue, at, limit) => {
        observed.add(queue);
        if (unavailable && queue === "notify") throw new Error("lyxtest observation unavailable");
        return channel.observe!(queue, at, limit);
      },
    },
    assembly: assembleForTest({ entry: "worker" }),
    probe: { db: prisma, holder: () => "node-a:test", queues },
  });
  const closeAlertDispatcher = vi.spyOn(services, "closeAlertDispatcher");
  const runtime = createWorkerRuntime({ services, channel, logger: silentLogger });
  try {
    await expect.poll(() => channel.ping(), { timeout: 2000, interval: 10 }).toBe(true);
    await channel.enqueue("media_job", "lyxtest-old-media", {});
    // 唯一真实工厂入队；仅把这条测试任务的时间戳设到业务时钟前，验证实际最老等待。
    await (
      await redis.raw()
    ).hset(
      `${redis.prefix}bull:media_job:lyxtest-old-media`,
      "timestamp",
      clock.now().getTime() - 301_000,
    );
    expect(DOMAIN_LOOPS.filter((loop) => loop.name === "probe")).toHaveLength(1);
    const loop = runtime.domainLoops["probe"];
    expect(loop?.intervalMs).toBe(60_000);
    await loop!.tick();
    expect(
      (await prisma.workerLease.findUniqueOrThrow({ where: { name: "primary" } })).probeAt,
    ).toEqual(clock.now());
    // 空库没有已完成周期：新规则必须报出真实漏跑，原四组/Redis仍健康。
    expect(
      await prisma.alertEvent.findMany({
        select: { fingerprint: true, severity: true },
        orderBy: { fingerprint: "asc" },
      }),
    ).toEqual(
      [
        ...services.timers.registry.recurringJobs
          .filter((job) => job.missSeverity !== undefined && job.deadlineMin !== undefined)
          .map((job) => ({
            fingerprint: `recurring.missed:${job.kind}`,
            severity: job.missSeverity,
          })),
        { fingerprint: "queue.backlog:media_job", severity: "P2" },
        { fingerprint: "backup.stale", severity: "P1" },
      ].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
    );
    expect([...observed].sort()).toEqual([...queues].sort());
    unavailable = true;
    for (let i = 0; i < 3; i++) {
      clock.advance(60_000);
      await loop!.tick();
    }
    expect(
      await prisma.alertEvent.findFirst({ where: { fingerprint: "probe.failed:queue.notify" } }),
    ).toMatchObject({ severity: "P2", status: "open" });
    await runtime.stop();
    expect(closeAlertDispatcher).toHaveBeenCalledTimes(1);
    await expect(services.runProbes!()).rejects.toThrow("已关闭");
    expect(() =>
      services.assembly.recurringJob("backup.pgdump")!.run({ scheduledFor: clock.now() }),
    ).toThrow("备份运行时已经关闭");
    expect(await prisma.workerLease.count()).toBe(1);
  } finally {
    await runtime.stop();
    await channel.close();
  }
});
