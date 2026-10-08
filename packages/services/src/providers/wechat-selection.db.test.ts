import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTxRunner, assembleProviders, detach } from "../kernel/index.js";
import { createRecordingLogger, useTestDatabase, useTestRedis } from "../testing/index.js";
import { createProviders, ProviderConfigError } from "./index.js";

const db = useTestDatabase("services");
const redis = useTestRedis();
const closers: Array<() => Promise<void>> = [];
const config = { appid: "wx_selection_test", secret: "public-fake-secret" };
let connection: Awaited<ReturnType<typeof redis.client>>;
beforeAll(async () => {
  connection = await redis.client();
});
afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
});
const transport = (fetchImpl: typeof fetch) => ({
  redis: connection,
  prefix: redis.prefix,
  now: () => new Date(),
  registerClose: (close: () => Promise<void>) => closers.push(close),
  fetchImpl,
});

describe("微信真实配置选择与原装配guard", () => {
  it.each(["local", "test", "stg", "prod"] as const)(
    "%s完整配置构建不外呼，登录经唯一真实驱动",
    async (appEnv) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ openid: "fake-openid", session_key: "discard" })),
        );
      const logger = createRecordingLogger();
      const providers = createProviders({
        appEnv,
        logger,
        settings: { wechat: config },
        wechat: transport(fetchImpl),
      });
      expect(providers.wechat.status).toBe("wechat");
      expect(providers.wechat.configured).toBe(true);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(await providers.wechat.code2Session({ code: "fake-code" })).toEqual({
        ok: true,
        value: { openid: "fake-openid" },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logger.lines)).not.toContain(config.secret);
    },
  );
  it("配置与运行时依赖不能半配，错误不带敏感值", () => {
    const options = { appEnv: "test" as const, logger: createRecordingLogger() };
    expect(() => createProviders({ ...options, settings: { wechat: config } })).toThrow(
      ProviderConfigError,
    );
    expect(() => createProviders({ ...options, wechat: transport(vi.fn<typeof fetch>()) })).toThrow(
      ProviderConfigError,
    );
    try {
      createProviders({ ...options, settings: { wechat: config } });
    } catch (error) {
      expect(String(error)).not.toContain(config.secret);
    }
  });
  it("真实TX与存活祖先先拦截外呼，TX外仅调用一次", async () => {
    const prisma = await db.prisma();
    const tx = createTxRunner({ prisma, appEnv: "test" });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ openid: "fake-openid" })));
    const providers = assembleProviders({
      appEnv: "test",
      logger: createRecordingLogger(),
      settings: { wechat: config },
      wechat: transport(fetchImpl),
    });
    expect(providers.wechat.status).toBe("wechat");
    await tx.run(async (handle) => {
      await handle.$queryRaw`SELECT 1`;
      await expect(providers.wechat.code2Session({ code: "fake" })).rejects.toMatchObject({
        kind: "external_call_in_transaction",
      });
      await detach(async () => {
        await expect(providers.wechat.code2Session({ code: "fake" })).rejects.toMatchObject({
          kind: "external_call_in_transaction",
        });
      });
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await providers.wechat.code2Session({ code: "fake" })).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
