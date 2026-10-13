import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as kernel from "../kernel/index.js";
import type { Env } from "../kernel/index.js";
import type { ModelBudgetTransport } from "../media/index.js";
import { createRuntime } from "../runtime.js";
import type { RuntimeOptions } from "../runtime.js";
import { createLogger } from "../logger.js";
import {
  createClock,
  createFakeProviders,
  createMediaAssetsHarness,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";

const db = useSeededDatabase("services", { max: 1, label: "apimodel" }),
  redis = useTestRedis();
const clock = createClock(),
  runtimes: ReturnType<typeof createRuntime>[] = [],
  harnesses: Awaited<ReturnType<typeof createMediaAssetsHarness>>[] = [];
let prisma: Awaited<ReturnType<typeof db.prisma>>, client: Awaited<ReturnType<typeof redis.raw>>;
const asr = { secretId: "AKIDEXAMPLE", secretKey: "PUBLIC_API_ASR" };
const llm: NonNullable<Env["LLM_DOMESTIC"]> = {
  text: {
    primary: { vendor: "deepseek", model: "api-text", apiKey: "PUBLIC_API_TEXT" },
    backup: { vendor: "ark", model: "api-backup", apiKey: "PUBLIC_API_BACKUP" },
  },
  vision: {
    primary: { vendor: "ark", model: "api-vision", apiKey: "PUBLIC_API_VISION" },
    backup: { vendor: "deepseek", model: "api-vision-backup", apiKey: "PUBLIC_API_VISION_BACKUP" },
  },
};
function lifecycle() {
  const closers: Array<() => Promise<void>> = [];
  let closing: Promise<void> | undefined;
  return {
    registerClose: vi.fn((close: () => Promise<void>) => closers.push(close)),
    close: vi.fn(
      () => (closing ??= Promise.allSettled(closers.map((close) => close())).then(() => undefined)),
    ),
  };
}
async function options(settings: Partial<Env> = {}, overrides: Partial<RuntimeOptions> = {}) {
  return {
    entry: "api" as const,
    version: "public-api-model",
    clock,
    env: {
      ...kernel.loadEnv({
        APP_ENV: "test",
        DATABASE_URL: await db.url(),
        REDIS_URL: process.env.REDIS_URL,
      }),
      ...settings,
    },
    redisKeyPrefix: redis.prefix,
    logger: createLogger({
      svc: "api",
      env: "test",
      level: "error",
      version: "public",
      destination: { write() {} },
    }),
    ...overrides,
  };
}
async function build(settings: Partial<Env> = {}, overrides: Partial<RuntimeOptions> = {}) {
  const models = lifecycle(),
    runtime = createRuntime(await options(settings, { modelDrivers: models, ...overrides }));
  runtimes.push(runtime);
  return { runtime, models };
}
beforeAll(async () => {
  prisma = await db.prisma();
  client = await redis.raw();
}, 60_000);
beforeEach(async () => {
  await db.reset();
  await redis.flush();
  clock.set(new Date());
  vi.clearAllMocks();
}, 60_000);
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const h of harnesses.splice(0)) await h.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}, 60_000);
function chat(value: unknown) {
  return new Response(
    JSON.stringify({
      choices: [
        { finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(value) } },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
}
function transport() {
  const key = `${redis.prefix}apimodel:model_budget:v1`;
  const evalCall = vi.fn<ModelBudgetTransport["eval"]>(async (script, keys, argv) => {
    kernel.assertNotInTransaction("API预算Redis");
    expect(keys).toEqual(["lyx:test:model_budget:v1"]);
    return client.eval(script, 1, key, ...argv);
  });
  return { key, evalCall, port: { eval: evalCall } };
}
async function asset(runtime: ReturnType<typeof createRuntime>) {
  const h = await createMediaAssetsHarness(prisma);
  harnesses.push(h);
  h.clock.set(clock.now());
  const saved = await runtime.media.assets.create(h.owner, {
    type: "text",
    textBody: "公开虚构门店菜单",
  });
  const audit = await prisma.mediaJob.findFirstOrThrow({
    where: { parentId: saved.storeAssetId, kind: "audit_text" },
  });
  await runtime.media.jobs.run({ jobId: audit.id });
  const job = await prisma.mediaJob.findFirstOrThrow({
    where: { parentId: saved.storeAssetId, kind: "digest" },
  });
  return { h, saved, job };
}
describe("API实际模型与预算运行时接线", { timeout: 60_000 }, () => {
  it("未配/仅ASR/仅LLM/两者选择准确，构造零模型HTTP且各自close成对", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    for (const selected of ["none", "asr", "llm", "both"]) {
      const settings = {
        ...(["asr", "both"].includes(selected) ? { ASR_TENCENT: asr } : {}),
        ...(["llm", "both"].includes(selected) ? { LLM_DOMESTIC: llm } : {}),
      };
      const { runtime, models } = await build(settings);
      expect(runtime.providers.asr.status).toBe(settings.ASR_TENCENT ? "tencent" : "unconfigured");
      expect(runtime.providers.llm.status).toBe(
        settings.LLM_DOMESTIC ? "domestic-llm" : "unconfigured",
      );
      expect(models.registerClose).toHaveBeenCalledTimes(
        selected === "both" ? 2 : selected === "none" ? 0 : 1,
      );
      const closing = runtime.close();
      expect(runtime.close()).toBe(closing);
      await closing;
      expect(models.close).toHaveBeenCalledTimes(selected === "none" ? 0 : 1);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("仅LLM也在工厂前要求完整close；借用providers不创建或关闭借用模型", async () => {
    const factory = vi.spyOn(kernel, "assembleProviders");
    const incomplete = await options({ LLM_DOMESTIC: llm });
    expect(() => createRuntime(incomplete)).toThrow("成对");
    expect(factory).not.toHaveBeenCalled();
    const providers = createFakeProviders({ clock });
    const { runtime, models } = await build({ LLM_DOMESTIC: llm, ASR_TENCENT: asr }, { providers });
    expect(runtime.providers).toBe(providers);
    expect(factory).not.toHaveBeenCalled();
    expect(models.registerClose).not.toHaveBeenCalled();
    await runtime.close();
    expect(models.close).not.toHaveBeenCalled();
    expect(await providers.llm.extractKeyPoints({ text: "菜单", maxPoints: 1 })).toMatchObject({
      ok: true,
    });
  });
  it("API的LLM保留唯一KF-1事务守卫，关闭取消在途模型且不影响另一实例", async () => {
    const first = await build({ LLM_DOMESTIC: llm }),
      second = await build({ LLM_DOMESTIC: llm });
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    await expect(
      first.runtime.tx.run(() =>
        first.runtime.providers.llm.extractKeyPoints({ text: "菜单", maxPoints: 1 }),
      ),
    ).rejects.toBeInstanceOf(kernel.KernelViolation);
    expect(fetch).not.toHaveBeenCalled();
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fetch.mockImplementationOnce(
      async (_url, init) =>
        new Promise<Response>((_, reject) => {
          entered();
          init!.signal!.addEventListener("abort", () => reject(new Error("public-stop")), {
            once: true,
          });
        }),
    );
    const active = first.runtime.providers.llm.extractKeyPoints({ text: "菜单", maxPoints: 1 });
    await entry;
    await first.runtime.close();
    expect(await active).toMatchObject({ ok: false });
    fetch.mockResolvedValueOnce(chat({ points: ["第二实例"] }));
    expect(
      await second.runtime.providers.llm.extractKeyPoints({ text: "菜单", maxPoints: 1 }),
    ).toMatchObject({ ok: true });
  });
  it("实际API素材digest走真实预算Lua与真实LLM协议；默认零额度/冷账本均保守关闭", async () => {
    const fake = createFakeProviders({ clock }),
      factory = kernel.assembleProviders;
    vi.spyOn(kernel, "assembleProviders").mockImplementation((input) => ({
      ...factory(input),
      media: fake.media,
    }));
    const budget = transport(),
      fetch = vi.fn<typeof globalThis.fetch>(async () =>
        chat({
          title: "",
          keypoints: ["公开虚构要点"],
          contentTags: [],
          suggestedUsage: [],
          faceHint: "none",
          qualityNotes: [],
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const { runtime } = await build({ LLM_DOMESTIC: llm }, { modelBudgetTransport: budget.port });
    const zero = await asset(runtime);
    await runtime.media.jobs.run({ jobId: zero.job.id });
    expect(
      (await prisma.mediaJob.findUniqueOrThrow({ where: { id: zero.job.id } })).output,
    ).toMatchObject({ reason: "budget_unconfigured" });
    expect(budget.evalCall).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    clock.set(new Date());
    await prisma.paramValue.create({
      data: {
        id: kernel.uuidv7(),
        key: "media.model.daily_call_cap",
        value: 100,
        effectiveAt: clock.now(),
        createdByStaffId: zero.h.staff.id,
        createdAt: clock.now(),
        reason: "只限自有隔离测试预算",
      },
    });
    const cold = await asset(runtime);
    clock.set(new Date());
    await runtime.media.jobs.run({ jobId: cold.job.id });
    expect(
      (await prisma.mediaJob.findUniqueOrThrow({ where: { id: cold.job.id } })).output,
    ).toMatchObject({ reason: "budget_unavailable" });
    expect(await client.exists(budget.key)).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(budget.evalCall).toHaveBeenCalledOnce();
    const warm = await asset(runtime);
    clock.set(new Date());
    const at = clock.now().getTime(),
      [seconds, micros] = await client.time();
    // 仅隔离测试HASH的合法既有历史；生产没有初始化/恢复接口。
    await client.hset(budget.key, {
      marker: "model_budget_v1",
      business: String(at - 1),
      redis: String(Number(seconds) * 1000 + Math.floor(Number(micros) / 1000) - 1),
      day: String(Math.floor((at + 28800000) / 86400000)),
      closed: "0",
      head: "1",
      next: "1",
      cursor: "1",
    });
    clock.set(new Date());
    await runtime.media.jobs.run({ jobId: warm.job.id });
    expect((await prisma.mediaJob.findUniqueOrThrow({ where: { id: warm.job.id } })).state).toBe(
      "succeeded",
    );
    expect(
      await prisma.storeAssetInsight.count({
        where: { storeAssetId: warm.saved.storeAssetId, kind: "digest" },
      }),
    ).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(budget.evalCall).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]![0])).toBe("https://api.deepseek.com/chat/completions");
  });
});
