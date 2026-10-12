import { createHmac } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, createRuntime, loadEnv, security, uuidv7 } from "@liyoxi/services";
import type { Env, RuntimeOptions } from "@liyoxi/services";
import {
  createClock,
  createFakeProviders,
  useSeededDatabase,
  useTestRedis,
} from "@liyoxi/services/testing";
import { createApp } from "../src/app.js";
import { asrHookHandlers } from "../src/routes/hooks/asr.js";

const db = useSeededDatabase("api", { max: 1 }),
  redis = useTestRedis(),
  SLOW = 120000;
const clock = createClock();
const asr = { secretId: "AKIDEXAMPLE", secretKey: "PUBLIC_CALLBACK_API" };
const callback = Object.freeze({ origin: "https://callbacks.example.com", key: "界".repeat(11) });
const runtimes: ReturnType<typeof createRuntime>[] = [];
const lifecycles: ReturnType<typeof lifecycle>[] = [];
let prisma: Awaited<ReturnType<typeof db.prisma>>;
function lifecycle() {
  const closers: Array<() => Promise<void>> = [];
  let closing: Promise<void> | undefined;
  return {
    registerClose: vi.fn((close: () => Promise<void>) => closers.push(close)),
    close: vi.fn(
      () => (closing ??= Promise.allSettled(closers.map((close) => close())).then(() => {})),
    ),
  };
}
async function build(settings: Partial<Env> = {}, options: Partial<RuntimeOptions> = {}) {
  const models = lifecycle();
  lifecycles.push(models);
  const runtime = createRuntime({
    entry: "api",
    version: "public-asr-callback",
    clock,
    env: {
      ...loadEnv({
        APP_ENV: "test",
        DATABASE_URL: await db.url(),
        REDIS_URL: process.env.REDIS_URL,
      }),
      ASR_TENCENT: asr,
      ASR_CALLBACK: callback,
      ...settings,
    },
    logger: createLogger({
      svc: "api",
      env: "test",
      level: "error",
      version: "callback",
      destination: { write() {} },
    }),
    redisKeyPrefix: redis.prefix,
    modelDrivers: models,
    ...options,
  });
  runtimes.push(runtime);
  const api = createApp({ runtime, handlers: asrHookHandlers });
  api.readiness.state = "ready";
  return { runtime, models, api };
}
async function request(
  api: ReturnType<typeof createApp>,
  id = uuidv7(),
  options: {
    key?: string;
    signature?: string;
    body?: string;
    contentType?: string;
  } = {},
) {
  const signature =
    options.signature ??
    createHmac("sha256", options.key ?? callback.key)
      .update(id)
      .digest("base64url");
  return api.app.request(`/api/v1/hooks/asr/media-jobs/${id}?sig=${signature}`, {
    method: "POST",
    headers: { "content-type": options.contentType ?? "application/x-www-form-urlencoded" },
    body: options.body ?? "requestId=9007199254740993&text=untrusted&status=success",
  });
}
beforeAll(async () => {
  prisma = await db.prisma();
}, SLOW);
beforeEach(async () => {
  await db.reset();
  await redis.flush();
  clock.set(new Date());
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("禁止未明确允许的模型HTTP");
    }),
  );
}, SLOW);
afterEach(async () => {
  try {
    for (const runtime of runtimes.splice(0).reverse()) await runtime.close();
    await Promise.allSettled(lifecycles.splice(0).map((models) => models.close()));
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
}, SLOW);

describe("API正式ASR默认回调装配", { timeout: SLOW }, () => {
  it.each(["none", "asr-only", "callback-only"] as const)(
    "%s默认来源关闭且零模型HTTP",
    async (config) => {
      const { api, models } = await build({
        ...(config === "asr-only" ? {} : { ASR_TENCENT: undefined }),
        ...(config === "callback-only" ? {} : { ASR_CALLBACK: undefined }),
      });
      const response = await request(api);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("failure");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await prisma.webhookEvent.count()).toBe(0);
      expect(models.registerClose).toHaveBeenCalledTimes(config === "asr-only" ? 1 : 0);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("完整自有配置默认来源实际验原UTF8 key；未知job仅记ignored且提交后提醒", async () => {
    const { api, runtime, models } = await build();
    const id = uuidv7();
    const wake = vi.spyOn(runtime.media.jobs, "wake").mockImplementation(async (jobId) => {
      expect(jobId).toBe(id);
      expect(await prisma.webhookEvent.findMany()).toEqual([
        expect.objectContaining({
          processState: "ignored",
          payload: null,
          eventId: `${id}:9007199254740993`,
        }),
      ]);
    });
    expect(runtime.providers.asr.status).toBe("tencent");
    expect(runtime.providers.llm.status).toBe("unconfigured");
    expect(fetch).not.toHaveBeenCalled();
    const response = await request(api, id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: 0, message: "success" });
    expect(wake).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledWith(id);
    const rows = await prisma.webhookEvent.findMany();
    expect(rows[0]).toMatchObject({ provider: "asr", eventType: "asr_callback", payload: null });
    expect(JSON.stringify(rows)).not.toContain("untrusted");
    expect(await prisma.mediaJob.count()).toBe(0);
    expect(models.registerClose).toHaveBeenCalledOnce();
    await runtime.close();
    await models.close();
    expect(models.close()).toBe(models.close());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("借用整套Provider即使公开状态为腾讯且完整Env也不自动启用或关闭", async () => {
    const borrowed = createFakeProviders({ clock });
    const { api, models } = await build(
      {},
      { providers: { ...borrowed, asr: { ...borrowed.asr, status: "tencent" } } },
    );
    expect((await request(api)).status).toBe(404);
    expect(models.registerClose).not.toHaveBeenCalled();
    expect(models.close).not.toHaveBeenCalled();
    expect(borrowed.asr.calls).toEqual([]);
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("显式空来源仍整表替换默认来源", async () => {
    const { api } = await build({}, { webhookSources: [] });
    const response = await request(api);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("failure");
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("显式来源整表替换而不拼接默认项，不授予付费模型权限", async () => {
    const customKey = "PUBLIC_CUSTOM_SOURCE_KEY_12345678";
    const handle = vi.fn<Parameters<typeof security.createAsrWebhookSource>[0]["wake"]>(
      async () => "ignored",
    );
    const { api } = await build(
      {},
      {
        webhookSources: [
          security.createAsrWebhookSource({ key: customKey, configured: () => true, wake: handle }),
        ],
      },
    );
    expect((await request(api)).status).toBe(401);
    expect((await request(api, uuidv7(), { key: customKey })).status).toBe(200);
    expect(handle).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(await prisma.mediaJob.count()).toBe(0);
  });

  it("两个自有实例的key独立；旧实例关闭不改变新实例验签", async () => {
    const first = await build(),
      id = uuidv7();
    expect((await request(first.api, id)).status).toBe(200);
    await first.runtime.close();
    const secondKey = "另".repeat(12);
    const second = await build({ ASR_CALLBACK: Object.freeze({ ...callback, key: secondKey }) });
    expect((await request(second.api, uuidv7())).status).toBe(401);
    expect((await request(second.api, uuidv7(), { key: secondKey })).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { name: "signature", signature: "A".repeat(43), status: 401 },
    { name: "duplicate-field", body: "requestId=1&%72equestId=1", status: 400 },
    { name: "uint64-overflow", body: "requestId=18446744073709551616", status: 400 },
    { name: "json", body: '{"requestId":"1"}', contentType: "application/json", status: 400 },
  ])("完整配置的$name保留协议拒绝且不落收件", async ({ status, ...options }) => {
    const { api, runtime } = await build();
    const wake = vi.spyOn(runtime.media.jobs, "wake");
    expect((await request(api, uuidv7(), options)).status).toBe(status);
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(wake).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("真实收件处理失败回滚receipt且不会在提交前唤醒队列", async () => {
    const { api, runtime } = await build();
    const id = uuidv7(),
      wake = vi.spyOn(runtime.media.jobs, "wake");
    vi.spyOn(runtime.media, "wakeAsrJob").mockImplementation(async (tx) => {
      expect(await tx.webhookEvent.count()).toBe(1);
      throw new Error("公开虚构收件后失败");
    });
    expect((await request(api, id)).status).toBe(500);
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(wake).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("重复真实receipt不重复插入，也不把回调text当识别结果", async () => {
    const { api, runtime } = await build(),
      id = uuidv7();
    vi.spyOn(runtime.media.jobs, "wake").mockResolvedValue(undefined);
    expect((await request(api, id)).status).toBe(200);
    const before = await prisma.webhookEvent.findMany();
    expect((await request(api, id)).status).toBe(200);
    expect(await prisma.webhookEvent.findMany()).toEqual(before);
    expect(await prisma.storeAssetInsight.count()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
