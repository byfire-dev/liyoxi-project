import { afterEach, expect, it } from "vitest";
import { useTestDatabase, useTestRedis } from "../../testing/index.js";
import { createTxRunner, KernelViolation } from "../tx.js";
import { createQueueChannel } from "./channel.js";
import type { QueueChannel } from "./channel.js";

const redis = useTestRedis(),
  db = useTestDatabase("services", { max: 1 });
const opened: QueueChannel[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((channel) => channel.close()));
});
async function open(prefix: string) {
  const channel = createQueueChannel({ redisUrl: process.env.REDIS_URL!, prefix });
  opened.push(channel);
  await expect.poll(() => channel.ping(), { timeout: 2000, interval: 10 }).toBe(true);
  return channel;
}
const now = Date.UTC(2026, 9, 13);

it("只读原子快照包含legacy/priority、真实最老及失败时间窗，越扫描上限/缺时间戳不伪造值", async () => {
  await redis.flush();
  const raw = await redis.raw(),
    prefix = `${redis.prefix}observe-read:bull`,
    channel = await open(prefix),
    key = (part: string) => `${prefix}:timer_run:${part}`;
  // BullMQ已持久形态的明确小夹具；不引第二个BullMQ入口，也不造几百个任务测容量。
  await raw
    .multi()
    .rpush(key("wait"), "new-head", "old-tail")
    .rpush(key("paused"), "legacy")
    .zadd(key("prioritized"), 1, "priority")
    .rpush(key("active"), "running")
    .hset(key("new-head"), "timestamp", now - 1000)
    .hset(key("old-tail"), "timestamp", now - 400_000)
    .hset(key("legacy"), "timestamp", now - 10_000)
    .hset(key("priority"), "timestamp", now - 200_000)
    .zadd(
      key("failed"),
      now - 600_001,
      "too-old",
      now - 600_000,
      "edge",
      now - 1,
      "recent",
      now + 1,
      "future",
    )
    .hset(key("meta"), "paused", "1", "fixture", "unchanged")
    .xadd(key("events"), `${now - 700_000}-0`, "event", "paused")
    .exec();
  const snapshot = async () => {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await raw.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");
    return Promise.all(keys.sort().map(async (key) => [key, await raw.dump(key)]));
  };
  const before = await snapshot();
  expect(await channel.observe!("timer_run", new Date(now), 4)).toEqual({
    waiting: 4,
    active: 1,
    failed10Min: 2,
    oldestWaitingAt: now - 400_000,
    oldestWaitingComplete: true,
    paused: true,
    pausedSince: now - 700_000,
    pauseTimeSource: "event",
  });
  expect(await channel.observe!("timer_run", new Date(now), 3)).toMatchObject({
    waiting: 4,
    oldestWaitingAt: null,
    oldestWaitingComplete: false,
  });
  expect(await snapshot()).toEqual(before);
  await raw.hdel(key("old-tail"), "timestamp");
  expect(await channel.observe!("timer_run", new Date(now), 4)).toMatchObject({
    waiting: 4,
    oldestWaitingAt: null,
    oldestWaitingComplete: false,
  });
  await raw.set(`${prefix}:promote:wait`, "wrong-type");
  await expect(channel.observe!("promote", new Date(now))).rejects.toThrow();
});

it("观测下界与关闭属于实例，本地pause不冒充global；截断窗口重置且TX内/非法参数拒绝", async () => {
  await redis.flush();
  const raw = await redis.raw(),
    prefix = `${redis.prefix}observe-life:bull`,
    a = await open(prefix),
    b = await open(prefix),
    key = (part: string) => `${prefix}:timer_run:${part}`;
  // 全局暂停可选择不发事件：不能把此前resumed之前的旧paused当作本轮起点。
  await raw.hset(key("meta"), "paused", 1);
  await raw.xadd(key("events"), `${now - 20}-0`, "event", "paused");
  await raw.xadd(key("events"), `${now - 10}-0`, "event", "resumed");
  expect(await a.observe!("timer_run", new Date(now))).toMatchObject({
    pausedSince: now,
    pauseTimeSource: "observed",
  });
  expect(await a.observe!("timer_run", new Date(now + 601_000))).toMatchObject({
    pausedSince: now,
  });
  expect(await b.observe!("timer_run", new Date(now + 601_000))).toMatchObject({
    pausedSince: now + 601_000,
  });
  // 两次观测间先恢复再无事件暂停：不能把上一轮暂停起点带到新一轮。
  await raw.hdel(key("meta"), "paused");
  await raw.xadd(key("events"), `${now + 602_000}-0`, "event", "resumed");
  await raw.hset(key("meta"), "paused", 1);
  expect(await a.observe!("timer_run", new Date(now + 603_000))).toMatchObject({
    pausedSince: now + 603_000,
  });
  // 少于1000条或空历史都可能是裁剪后的残余；数量小不能证明观测之间持续暂停。
  await raw.del(key("events"));
  await raw.xadd(key("events"), `${now + 604_000}-0`, "event", "waiting");
  expect(await a.observe!("timer_run", new Date(now + 605_000))).toMatchObject({
    pausedSince: now + 605_000,
  });
  await raw.del(key("events"));
  expect(await a.observe!("timer_run", new Date(now + 606_000))).toMatchObject({
    pausedSince: now + 606_000,
  });
  await raw.hdel(key("meta"), "paused");
  expect(await a.observe!("timer_run", new Date(now + 701_000))).toMatchObject({
    paused: false,
    pausedSince: null,
    pauseTimeSource: "none",
  });
  await raw.hset(key("meta"), "paused", 1);
  expect(await a.observe!("timer_run", new Date(now + 702_000))).toMatchObject({
    pausedSince: now + 702_000,
  });
  // 一千条极小事件覆盖窗口，早于窗口的观测不能证明暂停一直延续；没有大任务负载。
  const pipeline = raw.pipeline();
  for (let i = 0; i < 1000; i++)
    pipeline.xadd(key("events"), `${now + 800_001 + i}-0`, "event", "waiting");
  await pipeline.exec();
  expect(await a.observe!("timer_run", new Date(now + 900_000))).toMatchObject({
    pausedSince: now + 900_000,
    pauseTimeSource: "observed",
  });
  const consumer = a.consume("media_job", 1, async () => undefined);
  await consumer.pause();
  expect(await a.observe!("media_job", new Date(now))).toMatchObject({
    paused: false,
    pausedSince: null,
  });
  await consumer.close(0);
  const tx = createTxRunner({ prisma: await db.prisma(), appEnv: "test" });
  await expect(tx.run(() => a.observe!("timer_run", new Date(now)))).rejects.toBeInstanceOf(
    KernelViolation,
  );
  await expect(a.observe!("timer_run", new Date(now), 502)).rejects.toThrow("参数非法");
  await expect(a.observe!("timer_run", new Date("bad"))).rejects.toThrow("参数非法");
  const closed = a.close();
  expect(a.close()).toBe(closed);
  await closed;
  await expect(a.observe!("timer_run", new Date(now))).rejects.toThrow("已关闭");
  expect(await b.observe!("media_job", new Date(now))).toMatchObject({
    waiting: 0,
    oldestWaitingComplete: true,
  });
});
