import { expect, it } from "vitest";
import { buildWorkerServices, createQueueChannel } from "@liyoxi/services";
import {
  assembleForTest,
  createClock,
  useSeededDatabase,
  useTestRedis,
} from "@liyoxi/services/testing";
import { DOMAIN_LOOPS } from "../src/domain-loops.js";
import { silentLogger } from "../src/log.js";
import { createWorkerRuntime } from "../src/runtime.js";

const db = useSeededDatabase("worker", { max: 1 }),
  redis = useTestRedis();
it("正式probe循环真实写完成心跳，worker关闭同时关闭探针且借用池仍可用", async () => {
  const prisma = await db.prisma(),
    clock = createClock();
  await redis.flush();
  const channel = createQueueChannel({
    redisUrl: process.env.REDIS_URL!,
    prefix: `${redis.prefix}bull`,
  });
  await prisma.$executeRawUnsafe(`INSERT INTO worker_lease(name,holder,holder_version,acquired_at,heartbeat_at)
    VALUES('primary','node-a:test','test',clock_timestamp(),clock_timestamp())`);
  const services = buildWorkerServices({
    appEnv: "test",
    prisma,
    clock,
    channel,
    assembly: assembleForTest({ entry: "worker" }),
    probe: { db: prisma, holder: () => "node-a:test" },
  });
  const runtime = createWorkerRuntime({ services, channel, logger: silentLogger });
  try {
    expect(DOMAIN_LOOPS.filter((loop) => loop.name === "probe")).toHaveLength(1);
    const loop = runtime.domainLoops["probe"];
    expect(loop?.intervalMs).toBe(60_000);
    await loop!.tick();
    expect(
      (await prisma.workerLease.findUniqueOrThrow({ where: { name: "primary" } })).probeAt,
    ).toEqual(clock.now());
    expect(await prisma.alertEvent.count()).toBe(0);
    await runtime.stop();
    await expect(services.runProbes!()).rejects.toThrow("已关闭");
    expect(await prisma.workerLease.count()).toBe(1);
  } finally {
    await runtime.stop();
    await channel.close();
  }
});
