import { resolveTestSession, resolveTestWorker } from "@liyoxi/db/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  assertTestRedisPrefix,
  flushTestRedis,
  TestRedisHandle,
  TestRedisPrefixError,
  testRedisPrefix,
  useTestRedis,
} from "./redis.js";

// 连库、连 Redis、起子进程的用例：实例忙的时候（别的会话同时在跑）会慢，时限放宽，不用缺省的 5 秒
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// Redis 的隔离（W0-05b 任务书 第 7 节第 6 条）：清空甲前缀后，乙前缀的键与不带测试前缀的键都还在。
// 连的是共享的那份 Redis，所以用例只动自己造的键：
//   甲 = 本 worker 的前缀；乙 = 一个造出来的“另一个 worker”的前缀（编号加 9000，撞不上真的 worker）；
//   “不带测试前缀的键”放在 lyx:selftest: 之下，带本会话与本 worker 的编号，用完自己删。

const session = resolveTestSession();
const worker = resolveTestWorker();
const a = useTestRedis();
const b = new TestRedisHandle(testRedisPrefix({ worker: String(9000 + Number(worker)) }));
/** 不在 lyx:test: 之下的键：清空哪个测试前缀都不该碰到它 */
const OUTSIDE = `lyx:selftest:w005b:${session}:${worker}:outside`;

const direct = new Redis(process.env.REDIS_URL ?? "");
const countOf = async (prefix: string) => (await direct.keys(`${prefix}*`)).length;

afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await b.dispose();
  await direct.del(OUTSIDE);
  direct.disconnect();
});

describe("Redis 按键前缀隔离", () => {
  it("前缀是 lyx:test:<会话标识>:<worker 编号>:，落在 lyx:{env}: 之下", () => {
    expect(a.prefix).toBe(`lyx:test:${session}:${worker}:`);
    expect(a.prefix).toBe(`lyx:test:${session}:${process.env.VITEST_POOL_ID}:`);
    expect(testRedisPrefix({ session: "s1", worker: "3" })).toBe("lyx:test:s1:3:");
    expect(b.prefix).not.toBe(a.prefix);
    expect(b.prefix.startsWith(a.prefix) || a.prefix.startsWith(b.prefix)).toBe(false);
  });

  it("带前缀的连接：键自动落在自己的前缀下，两个前缀各存各的", async () => {
    const [clientA, clientB] = [await a.client(), await b.client()];
    await clientA.set("counter", "1");
    await clientB.set("counter", "2");
    expect(await clientA.get("counter")).toBe("1");
    expect(await clientB.get("counter")).toBe("2");
    expect(await direct.get(`${a.prefix}counter`)).toBe("1");
    expect(await direct.get(`${b.prefix}counter`)).toBe("2");
  });

  it("清空甲前缀：甲的键全没了；乙前缀的键与不带测试前缀的键都还在", async () => {
    const [clientA, clientB] = [await a.client(), await b.client()];
    await a.flush();
    await b.flush();
    // 甲：字符串、哈希、列表、集合各来一些，个数超过一次 SCAN 的批量
    const fill = clientA.pipeline();
    for (let index = 0; index < 1200; index += 1) fill.set(`bulk:${index}`, String(index));
    fill.hset("hash", "field", "value").lpush("list", "x").sadd("set", "m");
    await fill.exec();
    await clientB.set("keep", "乙的键");
    await clientB.hset("keep:hash", "field", "value");
    await direct.set(OUTSIDE, "不带测试前缀的键");
    expect(await countOf(a.prefix)).toBe(1203);
    expect(await countOf(b.prefix)).toBe(2);

    const commands = vi.spyOn(Redis.prototype, "sendCommand");
    expect(await a.flush()).toBe(1203);
    const names = new Set(commands.mock.calls.map(([command]) => command.name.toLowerCase()));
    commands.mockRestore();
    // 清空只用了 SCAN 与 UNLINK，没有 FLUSHDB、FLUSHALL、KEYS
    expect([...names].sort()).toEqual(["scan", "unlink"]);

    expect(await countOf(a.prefix)).toBe(0);
    expect(await clientA.get("bulk:7")).toBeNull();
    expect(await countOf(b.prefix)).toBe(2);
    expect(await clientB.get("keep")).toBe("乙的键");
    expect(await clientB.hget("keep:hash", "field")).toBe("value");
    expect(await direct.get(OUTSIDE)).toBe("不带测试前缀的键");
    // 再清一次：没有可清的
    expect(await a.flush()).toBe(0);
  });

  it("收尾：清空自己的前缀并断开连接，别人的不动", async () => {
    const mine = new TestRedisHandle(testRedisPrefix({ worker: String(8000 + Number(worker)) }));
    const client = await mine.client();
    await client.set("leftover", "1");
    await (await b.client()).set("keep", "乙的键");
    await direct.set(OUTSIDE, "不带测试前缀的键");
    await mine.dispose();
    expect(client.status).toBe("end");
    expect(await countOf(mine.prefix)).toBe(0);
    expect(await direct.get(`${b.prefix}keep`)).toBe("乙的键");
    expect(await direct.get(OUTSIDE)).toBe("不带测试前缀的键");
  });

  it("首次取连接时先清掉这个前缀下上一轮的残留", async () => {
    const prefix = testRedisPrefix({ worker: String(7000 + Number(worker)) });
    await direct.set(`${prefix}stale`, "上一轮没收尾留下的");
    const handle = new TestRedisHandle(prefix);
    try {
      const client = await handle.client();
      expect(await client.get("stale")).toBeNull();
    } finally {
      await handle.dispose();
    }
  });
});

describe("前缀守卫", () => {
  const REJECTED: unknown[] = [
    "",
    "*",
    "lyx:",
    "lyx:test:",
    "lyx:test:s1:", // 少 worker 编号
    "lyx:test:s1:3", // 少结尾的冒号
    "lyx:test:*:3:",
    "lyx:test:s1:3:extra:",
    "lyx:local:s1:3:",
    "lyx:prod:bull:",
    "bull:",
    undefined,
    null,
  ];

  it("不是 lyx:test:<会话>:<worker>: 这个形状的前缀：清空即抛错，一条命令都不发", async () => {
    const commands = vi.spyOn(direct, "sendCommand");
    for (const prefix of REJECTED) {
      expect(() => assertTestRedisPrefix(prefix)).toThrow(TestRedisPrefixError);
      await expect(flushTestRedis(direct, prefix as string)).rejects.toBeInstanceOf(
        TestRedisPrefixError,
      );
      expect(() => new TestRedisHandle(prefix as string)).toThrow(TestRedisPrefixError);
    }
    expect(commands).not.toHaveBeenCalled();
  });

  it("拿带 keyPrefix 的连接来清空：拒绝（UNLINK 会再套一层前缀，删不到）", async () => {
    const prefixed = await a.client();
    await expect(flushTestRedis(prefixed, a.prefix)).rejects.toThrow(/不带 keyPrefix/);
  });
});
