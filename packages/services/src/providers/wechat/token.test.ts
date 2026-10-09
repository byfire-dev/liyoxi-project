import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWechatClient } from "./client.js";
import { createAccessTokenManager, createRedisTokenCache } from "./token.js";
import type { WechatTokenCache, TokenRecord } from "./token.js";

const config = { appid: "wxfake221", secret: "SECRET_NOT_REAL" };
const record = { token: "TOKEN_NOT_REAL", expiresAt: Date.now() + 7200_000 };
const memory = () => {
  const values = new Map<string, TokenRecord>();
  const cache: WechatTokenCache = {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => {
      values.set(key, value);
    },
    deleteIfValue: async (key, token) => {
      if (values.get(key)?.token === token) values.delete(key);
    },
  };
  return { cache, values };
};
const reply = (seconds = 7200, token = "TOKEN_NOT_REAL") =>
  new Response(JSON.stringify({ access_token: token, expires_in: seconds }));

describe("stable token实际余量和进程singleflight", () => {
  it("构建不取token；20并发一个POST forcefalse，余量345只缓存285秒", async () => {
    const f = vi.fn<typeof fetch>().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return reply(345);
    });
    const client = createWechatClient({ fetchImpl: f });
    const m = memory();
    let now = 1_000_000;
    const put = vi.spyOn(m.cache, "put");
    const manager = createAccessTokenManager(config, {
      client,
      cache: m.cache,
      now: () => new Date(now),
    });
    try {
      expect(f).not.toHaveBeenCalled();
      const results = await Promise.all(Array.from({ length: 20 }, () => manager.get()));
      expect(results.every((result) => result.ok)).toBe(true);
      expect(f).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({
        appid: config.appid,
        secret: config.secret,
        grant_type: "client_credential",
        force_refresh: false,
      });
      expect(put).toHaveBeenCalledWith(
        config.appid,
        { token: "TOKEN_NOT_REAL", expiresAt: now + 345_000 },
        285_000,
      );
      now += 284_000;
      expect((await manager.get()).ok).toBe(true);
      expect(f).toHaveBeenCalledTimes(1);
      now += 2_000;
      expect((await manager.get()).ok).toBe(true);
      expect(f).toHaveBeenCalledTimes(2);
    } finally {
      await manager.close();
      await client.close();
    }
  });
  it("<=60秒本次可用但不延长缓存", async () => {
    const m = memory();
    const put = vi.spyOn(m.cache, "put");
    const f = vi.fn<typeof fetch>().mockImplementation(async () => reply(30));
    const client = createWechatClient({ fetchImpl: f });
    const manager = createAccessTokenManager(config, {
      client,
      cache: m.cache,
      now: () => new Date(1_000),
    });
    try {
      expect((await manager.get()).ok).toBe(true);
      expect((await manager.get()).ok).toBe(true);
      expect(f).toHaveBeenCalledTimes(2);
      expect(put).not.toHaveBeenCalled();
    } finally {
      await manager.close();
      await client.close();
    }
  });
  it("配置拒绝业务视不可用，不泄露原文且失败singleflight释放", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errcode: 40125, errmsg: config.secret })),
      )
      .mockImplementation(async () => reply());
    const client = createWechatClient({ fetchImpl: f });
    const manager = createAccessTokenManager(config, {
      client,
      cache: memory().cache,
      now: () => new Date(),
    });
    try {
      const first = await manager.get();
      expect(first).toMatchObject({ ok: false, reason: "unavailable", code: 40125 });
      if (!first.ok) expect(first.code).toBe(40125);
      expect(JSON.stringify(first)).not.toContain(config.secret);
      expect((await manager.get()).ok).toBe(true);
      expect(f).toHaveBeenCalledTimes(2);
    } finally {
      await manager.close();
      await client.close();
    }
  });
  it.each([0, -1, 7201, 1.5, "7200", null])("非法expires_in=%s不成成功", async (seconds) => {
    const client = createWechatClient({
      fetchImpl: async () =>
        new Response(JSON.stringify({ access_token: "TOKEN_NOT_REAL", expires_in: seconds })),
    });
    const manager = createAccessTokenManager(config, {
      client,
      cache: memory().cache,
      now: () => new Date(),
    });
    try {
      expect(await manager.get()).toMatchObject({ ok: false, reason: "unavailable" });
    } finally {
      await manager.close();
      await client.close();
    }
  });
  it("Redis不可用由真实stable fallback；仍有效本地token可继续", async () => {
    const cache: WechatTokenCache = {
      get: async () => {
        throw Error("REDIS SECRET");
      },
      put: async () => {
        throw Error("REDIS SECRET");
      },
      deleteIfValue: async () => {
        throw Error("REDIS SECRET");
      },
    };
    const f = vi.fn<typeof fetch>().mockImplementation(async () => reply());
    const client = createWechatClient({ fetchImpl: f });
    const manager = createAccessTokenManager(config, { client, cache, now: () => new Date() });
    try {
      expect((await manager.get()).ok).toBe(true);
      expect((await manager.get()).ok).toBe(true);
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      await manager.close();
      await client.close();
    }
  });
  it("slow cache200ms预算可退化；close终止token fetch", async () => {
    const cache: WechatTokenCache = {
      get: () => new Promise(() => {}),
      put: async () => {},
      deleteIfValue: async () => {},
    };
    const client = createWechatClient({
      fetchImpl: async (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(Error("SECRET")), { once: true }),
        ),
    });
    const manager = createAccessTokenManager(config, {
      client,
      cache,
      now: () => new Date(),
      cacheTimeoutMs: 10,
    });
    const pending = manager.get();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await manager.close();
    expect(await pending).toMatchObject({ ok: false, reason: "unavailable" });
    await client.close();
    expect(await manager.get()).toMatchObject({ ok: false, reason: "unavailable" });
  });
});

const prefix = `lyx:test:w221http1:${randomBytes(4).toString("hex")}:`;
let redis: Redis;
const keys = new Set<string>();
beforeAll(async () => {
  redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6389/0", {
    keyPrefix: prefix,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  redis.on("error", () => {});
  await redis.connect();
  process.stderr.write(`WECHAT_TOKEN_OWN_REDIS_PREFIX ${prefix}\n`);
});
afterAll(async () => {
  try {
    if (keys.size) await redis.unlink(...keys);
    let cursor = "0";
    const remaining: string[] = [];
    do {
      const result = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100);
      cursor = result[0];
      remaining.push(...result[1]);
    } while (cursor !== "0");
    expect(remaining).toEqual([]);
    process.stderr.write(`WECHAT_TOKEN_OWN_REDIS_CLEAN ${prefix} keys=0\n`);
  } finally {
    redis.disconnect();
  }
});

describe("borrowed Redis真实前缀/TTL/CAS/双实例", () => {
  it("必须匹配借用client已有前缀", () => {
    expect(() => createRedisTokenCache(redis, "lyx:prod:")).toThrow();
  });
  it("只一次prefix，真实TTL且旧token不能删新token", async () => {
    const cache = createRedisTokenCache(redis, prefix);
    const appid = "wxcas";
    keys.add(`wx:token:${appid}`);
    await cache.put(appid, record, 2_000);
    expect(await cache.get(appid)).toEqual(record);
    expect(await redis.pttl(`wx:token:${appid}`)).toBeGreaterThan(0);
    expect(await redis.pttl(`wx:token:${appid}`)).toBeLessThanOrEqual(2_000);
    await cache.put(appid, { ...record, token: "NEW_TOKEN" }, 2_000);
    await cache.deleteIfValue(appid, record.token);
    expect((await cache.get(appid))?.token).toBe("NEW_TOKEN");
    await cache.deleteIfValue(appid, "NEW_TOKEN");
    expect(await cache.get(appid)).toBeNull();
    const raw = new Redis(process.env.REDIS_URL ?? "redis://localhost:6389/0");
    try {
      expect(await raw.exists(`${prefix}${prefix}wx:token:${appid}`)).toBe(0);
    } finally {
      raw.disconnect();
    }
  });
  it("两个manager借共享真实缓存，close不断父client", async () => {
    const cache = createRedisTokenCache(redis, prefix);
    const appid = "wxshared";
    keys.add(`wx:token:${appid}`);
    const f = vi.fn<typeof fetch>().mockImplementation(async () => reply());
    const client = createWechatClient({ fetchImpl: f });
    const a = createAccessTokenManager(
      { ...config, appid },
      { client, cache, now: () => new Date() },
    );
    const b = createAccessTokenManager(
      { ...config, appid },
      { client, cache, now: () => new Date() },
    );
    try {
      expect((await a.get()).ok).toBe(true);
      expect((await b.get()).ok).toBe(true);
      expect(f).toHaveBeenCalledTimes(1);
      await a.close();
      expect(await redis.ping()).toBe("PONG");
    } finally {
      await a.close();
      await b.close();
      await client.close();
    }
  });
  it("真实共享cache的两个实例各20并发均不重新获取", async () => {
    const cache = createRedisTokenCache(redis, prefix);
    const appid = "wxmany";
    keys.add(`wx:token:${appid}`);
    await cache.put(appid, record, 60_000);
    const f = vi.fn<typeof fetch>();
    const client = createWechatClient({ fetchImpl: f });
    const a = createAccessTokenManager(
      { ...config, appid },
      { client, cache, now: () => new Date() },
    );
    const b = createAccessTokenManager(
      { ...config, appid },
      { client, cache, now: () => new Date() },
    );
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => Promise.all([a.get(), b.get()])),
      );
      expect(
        results.flat().every((result) => result.ok && result.value.token === record.token),
      ).toBe(true);
      expect(f).not.toHaveBeenCalled();
    } finally {
      await a.close();
      await b.close();
      await client.close();
    }
  });
  it("own阻塞连接的真实Redis GET/SET超过200ms退化，不关闭父连接", async () => {
    const appid = "wxtimeout";
    const blockedKey = "blocker";
    keys.add(blockedKey);
    keys.add(`wx:token:${appid}`);
    // BRPOP只阻塞这个测试自有连接；不暂停服务器或其他连接。
    let released = false;
    const blocked = redis.brpop(blockedKey, 1).then((value) => {
      released = true;
      return value;
    });
    const f = vi.fn<typeof fetch>().mockImplementation(async () => reply());
    const client = createWechatClient({ fetchImpl: f });
    const manager = createAccessTokenManager(
      { ...config, appid },
      { client, cache: createRedisTokenCache(redis, prefix), now: () => new Date() },
    );
    try {
      expect((await manager.get()).ok).toBe(true);
      expect(released).toBe(false);
      expect(f).toHaveBeenCalledTimes(1);
      await manager.close();
      await blocked;
      expect(await redis.ping()).toBe("PONG");
    } finally {
      await manager.close();
      await client.close();
      await blocked;
    }
  });
  it("有界坏cache不当token、到期Redis真实删除", async () => {
    const cache = createRedisTokenCache(redis, prefix);
    const appid = "wxbad";
    keys.add(`wx:token:${appid}`);
    await redis.set(`wx:token:${appid}`, "x".repeat(5000));
    expect(await cache.get(appid)).toBeNull();
    await cache.put(appid, record, 30);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await cache.get(appid)).toBeNull();
  });
});
