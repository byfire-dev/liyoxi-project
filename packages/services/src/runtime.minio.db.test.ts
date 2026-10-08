import { describe, expect, it, vi } from "vitest";

import { assembleForTest, useTestDatabase, useTestRedis } from "./testing/index.js";
import { loadEnv } from "./kernel/index.js";
import * as providerAssembly from "./kernel/assembly/providers.js";
import { createLogger } from "./logger.js";
import { buildWorkerServices } from "./ops/worker.js";
import { createRuntime } from "./runtime.js";

const db = useTestDatabase("services");
const redis = useTestRedis();
const minio = {
  endpoint: "http://127.0.0.1:9100",
  publicEndpoint: "http://192.0.2.10:9100",
};
const wechat = {
  appid: "wx_minio_fake",
  secret: "public-fake-secret",
  messageToken: "public-fake-token",
  messageEncodingAESKey: "A".repeat(43),
};
const logger = () =>
  createLogger({
    svc: "api",
    env: "test",
    level: "debug",
    version: "fake",
    destination: { write() {} },
  });

describe("API 与 worker 的 MinIO 端点装配", () => {
  it.each([false, true])("API 传入端点，微信配置共存=%s", async (withWechat) => {
    const spy = vi.spyOn(providerAssembly, "assembleProviders");
    const runtime = createRuntime({
      entry: "api",
      env: {
        ...loadEnv({
          APP_ENV: "test",
          DATABASE_URL: await db.url(),
          REDIS_URL: process.env.REDIS_URL,
        }),
        MINIO: minio,
        ...(withWechat ? { WECHAT: wechat } : {}),
      },
      version: "fake",
      redisKeyPrefix: redis.prefix,
      logger: logger(),
    });
    try {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0].settings?.storage?.minio).toEqual(minio);
      if (withWechat) {
        expect(spy.mock.calls[0]?.[0].settings?.wechat).toEqual({
          appid: wechat.appid,
          secret: wechat.secret,
        });
        expect(runtime.providers.wechat.status).toBe("wechat");
      }
    } finally {
      await runtime.close();
      spy.mockRestore();
    }
  });

  it.each([false, true])("worker 从 keys:env 传入端点，微信配置共存=%s", async (withWechat) => {
    const spy = vi.spyOn(providerAssembly, "assembleProviders");
    const closers: Array<() => Promise<void>> = [];
    const services = buildWorkerServices({
      appEnv: "test",
      prisma: await db.prisma(),
      assembly: assembleForTest({ entry: "worker" }),
      channel: {
        enqueue: async () => {
          throw new Error("用例不入队");
        },
        downForMs: () => 0,
      },
      keys: { MINIO: minio },
      ...(withWechat
        ? {
            wechat: {
              config: wechat,
              transport: {
                redis: await redis.client(),
                prefix: redis.prefix,
                now: () => new Date(),
                registerClose: (close: () => Promise<void>) => closers.push(close),
              },
            },
          }
        : {}),
    });
    try {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0].settings?.storage?.minio).toEqual(minio);
      if (withWechat) {
        expect(spy.mock.calls[0]?.[0].settings?.wechat).toEqual({
          appid: wechat.appid,
          secret: wechat.secret,
        });
        expect(services.providers.wechat.status).toBe("wechat");
      }
    } finally {
      services.closeWebhooks?.();
      services.closeAnalytics?.();
      services.closeOrder?.();
      services.closeBillingTimers?.();
      services.closePublish?.();
      services.closeDelivery?.();
      await Promise.all(closers.map((close) => close()));
      spy.mockRestore();
    }
  });
});
