import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNotInTransaction, loadEnv, uuidv7 } from "./kernel/index.js";
import type { Env } from "./kernel/index.js";
import { createLogger } from "./logger.js";
import { createMedia } from "./media/index.js";
import {
  createClock,
  createFakeProviders,
  createMediaAssetsHarness,
  useSeededDatabase,
  useTestRedis,
} from "./testing/index.js";
import { createRuntime } from "./runtime.js";
import type { RuntimeOptions } from "./runtime.js";

const db = useSeededDatabase("services", { max: 1 });
const redis = useTestRedis();
const SLOW = 120000;
const clock = createClock();
const asr = { secretId: "AKIDEXAMPLE", secretKey: "PUBLIC_API_ASR" };
const cos: NonNullable<Env["COS"]> = {
  region: "ap-beijing",
  buckets: {
    secure: "secure-1250000000",
    asset: "asset-1250000000",
    media: "media-1250000000",
    pub: "pub-1250000000",
  },
  signer: { secretId: "PUBLIC_SIGNER", secretKey: "PUBLIC_SIGNER_KEY" },
  stsIssuer: { secretId: "PUBLIC_ISSUER", secretKey: "PUBLIC_ISSUER_KEY" },
};
let prisma: Awaited<ReturnType<typeof db.prisma>>;
const runtimes: ReturnType<typeof createRuntime>[] = [];
const lifecycles: ReturnType<typeof lifecycle>[] = [];
const harnesses: Awaited<ReturnType<typeof createMediaAssetsHarness>>[] = [];
const producers: ReturnType<typeof createMedia>[] = [];
function lifecycle() {
  const drivers: Array<() => Promise<void>> = [];
  let closing: Promise<void> | undefined;
  const registerClose = vi.fn((close: () => Promise<void>) => drivers.push(close));
  const close = vi.fn(
    () =>
      (closing ??= Promise.allSettled(drivers.map((one) => Promise.resolve().then(one))).then(
        (results) => {
          const failed = results.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        },
      )),
  );
  return { registerClose, close, drivers };
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}
function response(body: unknown) {
  return new Response(JSON.stringify({ Response: body }), {
    headers: { "content-type": "application/json" },
  });
}
async function env() {
  return loadEnv({
    APP_ENV: "test",
    DATABASE_URL: await db.url(),
    REDIS_URL: process.env.REDIS_URL,
  });
}
async function build(overrides: Partial<RuntimeOptions> = {}, settings: Partial<Env> = {}) {
  const models = lifecycle();
  lifecycles.push(models);
  const runtime = createRuntime({
    entry: "api",
    env: { ...(await env()), ASR_TENCENT: asr, ...settings },
    version: "public-api-asr",
    clock,
    logger: createLogger({
      svc: "api",
      env: "test",
      level: "error",
      version: "public-api-asr",
      destination: { write() {} },
    }),
    redisKeyPrefix: redis.prefix,
    modelDrivers: models,
    ...overrides,
  });
  runtimes.push(runtime);
  return { runtime, models };
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
      throw new Error("未明确允许的模型HTTP");
    }),
  );
}, SLOW);
afterEach(async () => {
  try {
    for (const producer of producers.splice(0)) await producer.jobs.shutdown();
    for (const h of harnesses.splice(0)) await h.close();
    await Promise.allSettled(
      runtimes
        .splice(0)
        .reverse()
        .map((runtime) => runtime.close()),
    );
    await Promise.allSettled(lifecycles.splice(0).map((models) => models.close()));
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
}, SLOW);

describe("API真实ASR工厂与本实例所有权", { timeout: SLOW }, () => {
  it.each(["local", "test", "stg", "prod"] as const)(
    "%s显式配置仅选择实际ASR，构造不请求模型HTTP",
    async (appEnv) => {
      const { runtime, models } = await build({}, { APP_ENV: appEnv });
      expect(runtime.providers.asr.status).toBe("tencent");
      expect(runtime.providers.asr.configured).toBe(true);
      expect(runtime.providers.llm.status).toBe("unconfigured");
      expect(models.registerClose).toHaveBeenCalledOnce();
      expect(models.drivers).toHaveLength(1);
      expect(fetch).not.toHaveBeenCalled();
      expect(
        await runtime.providers.asr.transcribe({ url: "https://public.invalid/audio" }),
      ).toMatchObject({ ok: false, reason: "unsupported" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("默认不配置ASR无需生命周期口，LLM配置也不由API消费", async () => {
    const { runtime, models } = await build(
      { modelDrivers: undefined },
      {
        ASR_TENCENT: undefined,
        LLM_DOMESTIC: {
          text: {
            primary: { vendor: "deepseek", model: "public-text", apiKey: "PUBLIC_TEXT" },
            backup: { vendor: "ark", model: "public-backup", apiKey: "PUBLIC_BACKUP" },
          },
          vision: {
            primary: { vendor: "ark", model: "public-vision", apiKey: "PUBLIC_VISION" },
            backup: { vendor: "bailian", model: "public-image", apiKey: "PUBLIC_IMAGE" },
          },
        },
      },
    );
    expect(runtime.providers.asr.status).toBe("unconfigured");
    expect(runtime.providers.llm.status).toBe("unconfigured");
    expect(models.registerClose).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["missing", "register", "close"] as const)(
    "自有ASR的%s生命周期缺口在基础设施构造前拒绝",
    async (missing) => {
      const models = lifecycle();
      const options = {
        entry: "api" as const,
        env: { ...(await env()), ASR_TENCENT: asr },
        version: "public-pair",
        modelDrivers:
          missing === "missing"
            ? undefined
            : {
                registerClose: missing === "register" ? undefined : models.registerClose,
                close: missing === "close" ? undefined : models.close,
              },
      };
      // 明确无效输入边界；不改变正式成对端口类型。
      expect(() => createRuntime(options as RuntimeOptions)).toThrow("成对");
      expect(models.registerClose).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("借用整套Providers优先，不创建登记或关闭模型", async () => {
    const fake = createFakeProviders();
    const { runtime, models } = await build({ providers: fake });
    expect(runtime.providers).toBe(fake);
    expect(models.registerClose).not.toHaveBeenCalled();
    const first = runtime.close();
    expect(runtime.close()).toBe(first);
    await first;
    expect(models.close).not.toHaveBeenCalled();
    expect(fake.asr.callsOf("submit")).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("原唯一外呼守卫在真实PG事务内阻止模型HTTP", async () => {
    const { runtime } = await build();
    await expect(
      runtime.tx.run(() =>
        runtime.providers.asr.submit({
          url: "https://public.invalid/audio",
        }),
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("实际驱动签名与uint64回查保留，API不创建同步转写", async () => {
    const calls = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      assertNotInTransaction("runtime.asr.controlled-http");
      expect(String(url)).toBe("https://asr.tencentcloudapi.com/");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toContain("TC3-HMAC-SHA256");
      expect(headers.get("x-tc-timestamp")).toBe(String(Math.floor(clock.now().getTime() / 1000)));
      return headers.get("x-tc-action") === "CreateRecTask"
        ? response({ RequestId: "public-submit", Data: { TaskId: "9007199254740993" } })
        : response({
            RequestId: "public-query",
            Data: {
              TaskId: "9007199254740993",
              Status: 0,
              StatusStr: "waiting",
            },
          });
    });
    vi.stubGlobal("fetch", calls);
    const { runtime } = await build();
    expect(
      await runtime.providers.asr.submit({ url: "https://public.invalid/audio" }),
    ).toMatchObject({ ok: true, value: { taskId: "9007199254740993" } });
    expect(await runtime.providers.asr.query({ taskId: "9007199254740993" })).toMatchObject({
      ok: true,
      value: { state: "waiting" },
    });
    expect(calls.mock.calls[1]![1]?.body).toBe('{"TaskId":9007199254740993}');
    expect(calls).toHaveBeenCalledTimes(2);
  });
  it("关闭等待实际请求取消收尾，重复close共用Promise且实例互不关闭", async () => {
    const entered = deferred(),
      canceled = deferred(),
      release = deferred();
    const calls = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            canceled.release();
            void release.promise.then(() => {
              init?.signal?.removeEventListener("abort", abort);
              reject(new Error("公开替身传输已取消"));
            });
          };
          init?.signal?.addEventListener("abort", abort, { once: true });
          entered.release();
        }),
    );
    vi.stubGlobal("fetch", calls);
    const first = await build(),
      second = await build();
    const work = first.runtime.providers.asr.query({ taskId: "10" });
    await entered.promise;
    let closed = false;
    const closing = first.runtime.close();
    void closing.then(() => {
      closed = true;
    });
    try {
      expect(first.runtime.close()).toBe(closing);
      await canceled.promise;
      expect(closed).toBe(false);
      expect(first.models.close).toHaveBeenCalledOnce();
    } finally {
      release.release();
      await Promise.allSettled([work, closing]);
    }
    expect(await first.runtime.providers.asr.query({ taskId: "10" })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    calls.mockImplementation(async () =>
      response({
        RequestId: "public-second",
        Data: {
          TaskId: "10",
          Status: 0,
          StatusStr: "waiting",
        },
      }),
    );
    expect(await second.runtime.providers.asr.query({ taskId: "10" })).toMatchObject({ ok: true });
    expect(second.models.close).not.toHaveBeenCalled();
  });
  it("早期cleanup失败仍关闭驱动和基础设施，保留首异常", async () => {
    const { runtime, models } = await build();
    const failure = new Error("public-cleanup-failure");
    const shutdown = vi.spyOn(runtime.media.jobs, "shutdown").mockRejectedValue(failure);
    const closing = runtime.close();
    await expect(closing).rejects.toBe(failure);
    expect(runtime.close()).toBe(closing);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(models.close).toHaveBeenCalledOnce();
    expect(await runtime.providers.asr.query({ taskId: "10" })).toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(await prisma.$queryRaw`SELECT 1 AS alive`).toEqual([{ alive: 1 }]);
  });
});

async function ready(runtime: ReturnType<typeof createRuntime>) {
  const h = await createMediaAssetsHarness(prisma);
  harnesses.push(h);
  h.clock.set(clock.now());
  const producer = createMedia({
    tx: h.tx,
    clock,
    assembly: h.assembly,
    events: h.events,
    storage: h.fake.storage,
    moderation: h.fake.media,
    assets: { ...h.assets, asr: runtime.providers.asr },
  });
  producers.push(producer);
  // 合法历史音频元数据；不宣称替身文件是原生音频或真实COS对象。
  const file = await h.make.fileObject({
    bucket: "asset",
    category: "store_asset",
    scopeType: "store",
    entityId: h.merchant.entity.id,
    storeId: h.merchant.store.id,
    uploadActorType: "merchant",
    uploadActorId: h.merchant.user.id,
    uploadClient: "weapp",
    ext: "wav",
    mime: "audio/wav",
    declaredMime: "audio/wav",
    etag: "public-audio-etag",
    crc64: "12345",
    sizeBytes: 48n,
    declaredSize: 48n,
  });
  const asset = await producer.assets.create(h.owner, { type: "audio", fileIds: [file.id] });
  const probe = await prisma.mediaJob.findFirstOrThrow({
    where: { parentId: asset.storeAssetId, kind: "probe" },
  });
  await producer.jobs.run({ jobId: probe.id });
  const job = await prisma.mediaJob.findFirstOrThrow({
    where: { parentId: asset.storeAssetId, kind: "asr" },
  });
  expect(job).toMatchObject({ state: "queued", mode: "remote", provider: "tencent" });
  return { h, job, asset };
}
describe("API误驱动新ASR保守关闭与已有TaskId回查", { timeout: SLOW }, () => {
  it.each([0, 10])("实际COS签名通过后，global cap=%s仍没有新提交HTTP", async (cap) => {
    const { runtime } = await build({}, { COS: cos });
    const { h, job } = await ready(runtime);
    if (cap)
      await prisma.paramValue.create({
        data: {
          id: uuidv7(),
          key: "media.model.daily_call_cap",
          value: cap,
          effectiveAt: clock.now(),
          createdAt: clock.now(),
          createdByStaffId: h.staff.id,
        },
      });
    const signed = vi.spyOn(runtime.providers.storage, "presignGet");
    await runtime.media.jobs.run({ jobId: job.id });
    expect(signed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ expiresSec: 7200 }));
    expect(await signed.mock.results[0]!.value).toMatchObject({ ok: true });
    expect(await prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      state: "succeeded",
      externalJobId: null,
      output: {
        status: "skipped",
        reason: cap ? "budget_unavailable" : "budget_unconfigured",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await prisma.storeAssetInsight.count({
        where: {
          storeAssetId: job.parentId!,
          kind: "transcript",
          status: "ok",
        },
      }),
    ).toBe(0);
  });
  it("合法历史TaskId在默认零额度和无transport下只回查，不重提不签源URL", async () => {
    const calls = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      assertNotInTransaction("runtime.asr.existing-query");
      expect(new Headers(init?.headers).get("x-tc-action")).toBe("DescribeTaskStatus");
      return response({
        RequestId: "public-existing",
        Data: {
          TaskId: "9007199254740993",
          Status: 0,
          StatusStr: "waiting",
        },
      });
    });
    vi.stubGlobal("fetch", calls);
    const { runtime } = await build({}, { COS: cos });
    const { job } = await ready(runtime);
    // 明确受理后已持久化的合法历史状态；不伪造本轮曾提交或已扣账本。
    await prisma.mediaJob.update({
      where: { id: job.id },
      data: {
        state: "submitted",
        attemptNo: 1,
        externalJobId: "9007199254740993",
        nextRunAt: clock.now(),
        leaseOwner: null,
      },
    });
    const signed = vi.spyOn(runtime.providers.storage, "presignGet");
    await runtime.media.jobs.run({ jobId: job.id });
    expect(calls).toHaveBeenCalledOnce();
    expect(calls.mock.calls[0]![1]?.body).toBe('{"TaskId":9007199254740993}');
    expect(signed).not.toHaveBeenCalled();
    expect(await prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      state: "submitted",
      attemptNo: 1,
      externalJobId: "9007199254740993",
    });
  });
});
