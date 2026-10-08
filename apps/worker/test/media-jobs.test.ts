import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildWorkerServices,
  createMedia,
  createQueueChannel,
  createIdentityContext,
  uuidv7,
} from "@liyoxi/services";
import type { Env } from "@liyoxi/services";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  createSampleEvents,
  useSeededDatabase,
  useTestRedis,
} from "@liyoxi/services/testing";
import { createWorkerRuntime, QUEUE_CONCURRENCY } from "../src/runtime.js";
import { DOMAIN_LOOPS } from "../src/domain-loops.js";
import { silentLogger } from "../src/log.js";
const handle = useSeededDatabase("worker"),
  redis = useTestRedis(),
  clock = createClock();
let prisma: Awaited<ReturnType<typeof handle.prisma>>,
  channel: ReturnType<typeof createQueueChannel>;
const owned: ReturnType<typeof buildWorkerServices>[] = [];
const runtimes: ReturnType<typeof createWorkerRuntime>[] = [];
const ci: NonNullable<Env["CI"]> = {
  callback: {
    key: "public-fake-ci-callback-key-with-32-bytes",
    origin: "https://callback.example.invalid",
  },
  worker: {
    region: "ap-beijing",
    buckets: {
      secure: "test-secure-1250000000",
      asset: "test-asset-1250000000",
      media: "test-media-1250000000",
      pub: "test-pub-1250000000",
    },
    secretId: "public-fake-worker-id",
    secretKey: "public-fake-worker-key",
  },
};
beforeAll(async () => {
  prisma = await handle.prisma();
  await redis.flush();
  channel = createQueueChannel({ redisUrl: process.env.REDIS_URL!, prefix: `${redis.prefix}bull` });
  await channel.ping();
});
async function close(one: ReturnType<typeof buildWorkerServices>) {
  await one.shutdownMediaJobs?.();
  one.closeMediaJobs?.();
  one.closeOrder?.();
  one.closeBillingTimers?.();
  one.closePublish?.();
  one.closeDelivery?.();
  one.closeWebhooks?.();
  one.closeAnalytics?.();
  await Promise.all([one.closeMediaDrivers?.(), one.closeStorageDrivers?.()]);
}
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const one of owned.splice(0)) await close(one);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await channel.close();
});
function build(options: Partial<Parameters<typeof buildWorkerServices>[0]> = {}) {
  const one = buildWorkerServices({
    appEnv: "test",
    prisma,
    assembly: assembleForTest({ entry: "worker", omitReal: ["recurringJobs"] }),
    channel,
    clock,
    ...options,
  });
  owned.push(one);
  return one;
}
describe("W303真实worker媒体装配与恢复", () => {
  it("构造无外呼且真实factory选择CI；关闭仅自己驱动不关闭借用DB/队列", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const services = build({ keys: { CI: ci } });
    expect(services.providers.media.status).toBe("ci");
    expect(fetch).not.toHaveBeenCalled();
    await Promise.all([services.closeMediaDrivers!(), services.closeMediaDrivers!()]);
    expect(
      await services.providers.media.describe!({ jobId: "jfixture", family: "media" }),
    ).toMatchObject({ ok: false, reason: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await prisma.$queryRaw`SELECT 1 AS alive`).toEqual([{ alive: 1 }]);
    expect(await channel.ping()).toBe(true);
  });
  it("缺CI worker角色在绑定/factory前拒绝；未配保留正式unconfigured降级", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    expect(() => build({ keys: { CI: { callback: ci.callback } } })).toThrow(/CI.*worker/);
    expect(build({ appEnv: "stg" }).providers.media.status).toBe("unconfigured");
    expect(build().providers.media.status).toBe("local");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("actual worker own-close取消在途请求并等listener清理，不触兄弟存储", async () => {
    let entered!: () => void,
      listeners = 0;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const signal = init!.signal!;
      let abort!: () => void;
      try {
        return await new Promise<Response>((_resolve, reject) => {
          abort = () => reject(new Error("public fake abort"));
          listeners++;
          signal.addEventListener("abort", abort, { once: true });
          entered();
        });
      } finally {
        signal.removeEventListener("abort", abort);
        listeners--;
      }
    };
    vi.stubGlobal("fetch", fetch);
    const services = build({ keys: { CI: ci } });
    const sibling = services.providers.storage,
      siblingStatus = sibling.status;
    const pending = services.providers.media.describe!({ jobId: "jfixture", family: "media" });
    await waiting;
    await services.closeMediaDrivers!();
    expect(await pending).toMatchObject({ ok: false, reason: "unavailable" });
    expect(listeners).toBe(0);
    expect(services.providers.storage).toBe(sibling);
    expect(sibling.status).toBe(siblingStatus);
    expect(await prisma.$queryRaw`SELECT 1 AS alive`).toEqual([{ alive: 1 }]);
    expect(await channel.ping()).toBe(true);
  });
  it("已登记15秒/20行恢复循环与media_job队列；Redis丢醒后扫描持有IO且关停等真实完成", async () => {
    const fake = createFakeProviders({ clock }),
      sample = createSampleEvents(prisma, { registrations: [] });
    const services = build({ providers: fake });
    const runtime = createWorkerRuntime({ services, channel, logger: silentLogger });
    runtimes.push(runtime);
    expect(DOMAIN_LOOPS.filter((one) => one.name === "media_job_run")).toHaveLength(1);
    expect(runtime.domainLoops["media_job_run"]?.intervalMs).toBe(15_000);
    expect(QUEUE_CONCURRENCY.media_job).toBe(10);
    expect(runtime.consumers).not.toHaveProperty("promote");
    const make = createFactories({ db: prisma, clock }),
      user = await make.merchantUser(),
      entity = await make.entity({ createdByUserId: user.id }),
      store = await make.store({ entityId: entity.id });
    const media = createMedia({
      tx: sample.tx,
      clock,
      assembly: services.assembly,
      events: services.events,
      storage: fake.storage,
      channel,
      pollMs: 0,
    });
    const actor = {
      identity: createIdentityContext({
        actor: { type: "merchant", id: user.id, client: "weapp", role: "owner" },
        entityId: entity.id,
        storeId: store.id,
      }),
      merchant: { standing: "owner" as const, entityId: entity.id, storeId: store.id },
    };
    const file = (
      await media.register(actor, {
        category: "profile_image",
        files: [{ fileName: "fixture.png", sizeBytes: "8", clientToken: uuidv7() }],
      })
    ).items[0]!;
    fake.storage.put(
      { bucket: "asset", key: file.key },
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      "image/png",
    );
    await media.complete(actor, file.fileId);
    await redis.flush();
    fake.storage.delayNext("copy", 1000);
    let stopped = false;
    try {
      await runtime.domainLoops["media_job_run"]!.tick();
      await vi.waitFor(() => expect(fake.storage.pendingCalls()).toBe(1));
      expect(
        (await prisma.fileObject.findUniqueOrThrow({ where: { id: file.fileId } })).status,
      ).toBe("promoting");
      const stop = runtime.stop().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      clock.advance(1000);
      fake.storage.tick();
      await stop;
      expect(
        (await prisma.fileObject.findUniqueOrThrow({ where: { id: file.fileId } })).status,
      ).toBe("stored");
      expect(
        await prisma.mediaJob.findUniqueOrThrow({ where: { dedupeKey: `promote:${file.fileId}` } }),
      ).toMatchObject({ state: "succeeded", attemptNo: 1 });
      expect(
        await prisma.outboxEvent.count({
          where: { eventType: "file.stored", aggregateId: file.fileId },
        }),
      ).toBe(1);
      expect(fake.storage.pendingCalls()).toBe(0);
      await runtime.stop();
      expect(await channel.ping()).toBe(true);
    } finally {
      clock.advance(1000);
      fake.storage.tick();
      await runtime.stop();
      await media.jobs.shutdown();
    }
  });
});
