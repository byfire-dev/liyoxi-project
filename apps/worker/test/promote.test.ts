import { buildWorkerServicesForTest } from "./support/services.js";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  createMedia,
  createRuntime,
  createLogger,
  loadEnv,
  createIdentityContext,
  createQueueChannel,
  uuidv7,
} from "@liyoxi/services";
import {
  assembleForTest,
  createClock,
  createFactories,
  createFakeProviders,
  fakeKeyEnv,
  useSeededDatabase,
  useTestRedis,
} from "@liyoxi/services/testing";
import { createWorkerRuntime, QUEUE_CONCURRENCY } from "../src/runtime.js";
import { silentLogger } from "../src/log.js";
const db = useSeededDatabase("worker");
const redis = useTestRedis();
const clock = createClock();
let prisma: Awaited<ReturnType<typeof db.prisma>>;
let channel: ReturnType<typeof createQueueChannel>;
let services: ReturnType<typeof buildWorkerServicesForTest>;
let assembly: ReturnType<typeof assembleForTest>;
let media: ReturnType<typeof createMedia>;
let runtime: ReturnType<typeof createWorkerRuntime>;
let fake: ReturnType<typeof createFakeProviders>;
let actor: Parameters<typeof media.register>[0];
let serviceRuntime: ReturnType<typeof createRuntime>;
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
beforeAll(async () => {
  assembly = assembleForTest({ entry: "worker", omitReal: ["recurringJobs"] });
  fake = createFakeProviders({ clock });
  await redis.flush();
  channel = createQueueChannel({ redisUrl: process.env.REDIS_URL!, prefix: `${redis.prefix}bull` });
  await channel.ping();
}, 180_000);
// Each case has its own seeded facts: prior stored files can create real WX audit work.
beforeEach(async () => {
  await services?.shutdownMediaJobs?.();
  await media?.jobs.shutdown();
  await serviceRuntime?.close();
  await services?.closeNotify?.();
  await services?.closeAnalytics?.();
  services?.closeOrder?.();
  services?.closeBillingTimers?.();
  services?.closePublish?.();
  services?.closeDelivery?.();
  services?.closeWebhooks?.();
  services?.closeMediaJobs?.();
  await Promise.allSettled([services?.closeMediaDrivers?.(), services?.closeStorageDrivers?.()]);
  await db.reset();
  await redis.flush();
  prisma = await db.prisma();
  const make = createFactories({ db: prisma, clock });
  services = buildWorkerServicesForTest({
    appEnv: "test",
    prisma,
    assembly,
    channel,
    clock,
    providers: fake,
  });
  serviceRuntime = createRuntime({
    entry: "worker",
    env: {
      ...loadEnv({
        APP_ENV: "test",
        DATABASE_URL: await db.url(),
        REDIS_URL: process.env.REDIS_URL,
      }),
      ...fakeKeyEnv(),
    },
    version: "test",
    clock,
    providers: fake,
    redisKeyPrefix: redis.prefix,
  });
  media = createMedia({
    tx: serviceRuntime.tx,
    clock,
    assembly,
    events: services.events,
    storage: fake.storage,
    channel,
    pollMs: 0,
  });
  const user = await make.merchantUser();
  const entity = await make.entity({ createdByUserId: user.id });
  const store = await make.store({ entityId: entity.id });
  actor = {
    identity: createIdentityContext({
      actor: { type: "merchant", id: user.id, client: "weapp", role: "owner" },
      entityId: entity.id,
      storeId: store.id,
    }),
    merchant: { standing: "owner", entityId: entity.id, storeId: store.id },
  };
  runtime = createWorkerRuntime({ services, channel, logger: silentLogger });
}, 180_000);

afterEach(async () => {
  await runtime?.stop();
});
afterAll(async () => {
  await runtime?.stop();
  await channel?.close();
  await media?.jobs.shutdown();
  await serviceRuntime?.close();
});
async function queued() {
  const file = (
    await media.register(actor, {
      category: "profile_image",
      files: [{ fileName: "x.png", sizeBytes: "8", clientToken: uuidv7() }],
    })
  ).items[0]!;
  fake.storage.put({ bucket: "asset", key: file.key }, png, "image/png");
  await media.complete(actor, file.fileId);
  return {
    fileId: file.fileId,
    job: await prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${file.fileId}` },
    }),
  };
}
async function waitStored(fileId: string) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if ((await prisma.fileObject.findUniqueOrThrow({ where: { id: fileId } })).status === "stored")
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("promote 消费者没有把文件入库");
}
describe("promote 生产队列和数据库恢复", () => {
  it("独立前缀队列被清后，统一扫描直接恢复，重复投递仅一个 stored 事实", async () => {
    const file = await queued();
    expect(QUEUE_CONCURRENCY.media_job).toBe(10);
    await redis.flush();
    expect((await prisma.mediaJob.findUniqueOrThrow({ where: { id: file.job.id } })).state).toBe(
      "queued",
    );
    expect(await services.scanPromote()).toBe(1);
    await waitStored(file.fileId);
    expect((await prisma.fileObject.findUniqueOrThrow({ where: { id: file.fileId } })).status).toBe(
      "stored",
    );
    await channel.enqueue("media_job", uuidv7(), { jobId: file.job.id });
    runtime.consumers.media_job.start();
    await waitStored(file.fileId);
    await runtime.consumers.media_job.pause();
    expect(
      await prisma.outboxEvent.count({
        where: { eventType: "file.stored", aggregateId: file.fileId },
      }),
    ).toBe(1);
  });
  it("数据库 running 租约到期仍可由真实消费者接管", async () => {
    const file = await queued();
    await redis.flush();
    await prisma.mediaJob.update({
      where: { id: file.job.id },
      data: {
        state: "running",
        attemptNo: 1,
        leaseOwner: "dead-worker",
        startedAt: clock.now(),
        nextRunAt: clock.now(),
      },
    });
    expect(await services.scanPromote()).toBe(1);
    runtime.consumers.media_job.start();
    await waitStored(file.fileId);
    await runtime.consumers.media_job.pause();
    expect(await prisma.mediaJob.findUniqueOrThrow({ where: { id: file.job.id } })).toMatchObject({
      state: "succeeded",
      attemptNo: 2,
    });
  });
  it("真实Redis遗留promote重复消息转入media_job且只执行和写stored一次", async () => {
    const file = await queued();
    await redis.flush();
    await channel.enqueue("promote", uuidv7(), { jobId: file.job.id });
    await channel.enqueue("promote", uuidv7(), { jobId: file.job.id });
    runtime.consumers.promote.start();
    runtime.consumers.media_job.start();
    await waitStored(file.fileId);
    await runtime.consumers.promote.pause();
    await runtime.consumers.media_job.pause();
    expect(await prisma.mediaJob.findUniqueOrThrow({ where: { id: file.job.id } })).toMatchObject({
      state: "succeeded",
      attemptNo: 1,
    });
    expect(
      await prisma.outboxEvent.count({
        where: { eventType: "file.stored", aggregateId: file.fileId },
      }),
    ).toBe(1);
    expect(await channel.ping()).toBe(true);
  });
});

/** 现造 1×1 透明 PNG；有合法的 IHDR、压缩像素与各块 CRC，不读取用户图片。 */
function phonePng(): Uint8Array<ArrayBuffer> {
  const chunk = (type: string, body: Buffer) => {
    const data = Buffer.concat([Buffer.from(type), body]);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(body.length + 12);
    result.writeUInt32BE(body.length, 0);
    data.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(png),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function closeStorage(provider: unknown): void {
  if (
    provider &&
    typeof provider === "object" &&
    "close" in provider &&
    typeof provider.close === "function"
  )
    provider.close();
}

// 手机验收使用显式配置的 LAN 代理；常规 CI 不依赖它。required 时必须完整通过，不能跳过。
const phoneAcceptance = process.env.LYX_TEST_PHONE_PROXY === "required" ? it : it.skip;
phoneAcceptance(
  "真实 MinIO：complete 自动入队，由真实消费者入库并经手机代理回读",
  async () => {
    const publicEndpoint = process.env.MINIO_PUBLIC_ENDPOINT;
    if (!publicEndpoint?.trim())
      throw new Error("LYX_TEST_PHONE_PROXY=required 时必须配置 MINIO_PUBLIC_ENDPOINT");
    const runId = randomUUID();
    const prefix = `${redis.prefix}phone:${runId}:`;
    const liveClock = createClock(new Date());
    const livePrisma = await db.prisma();
    const env = {
      ...loadEnv({
        APP_ENV: "test",
        DATABASE_URL: await db.url(),
        REDIS_URL: process.env.REDIS_URL,
        MINIO_ENDPOINT: "http://127.0.0.1:9100",
        MINIO_PUBLIC_ENDPOINT: publicEndpoint,
      }),
      ...fakeKeyEnv(),
    };
    const publicOrigin = new URL(publicEndpoint.trim()).origin;
    const api = createRuntime({
      entry: "api",
      env,
      version: "phone-test",
      clock: liveClock,
      redisKeyPrefix: prefix,
      logger: createLogger({
        svc: "api",
        env: "test",
        level: "debug",
        version: "phone-test",
        destination: { write() {} },
      }),
    });
    const ownChannel = createQueueChannel({ redisUrl: env.REDIS_URL, prefix: `${prefix}bull` });
    const ownServices = buildWorkerServicesForTest({
      appEnv: "test",
      prisma: livePrisma,
      assembly: assembleForTest({ entry: "worker", omitReal: ["recurringJobs"] }),
      channel: ownChannel,
      clock: liveClock,
      keys: env,
    });
    const ownWorker = createWorkerRuntime({
      services: ownServices,
      channel: ownChannel,
      logger: silentLogger,
    });
    const created: Array<{ bucket: "asset"; key: string }> = [];
    let cleanupFailure: PromiseRejectedResult | undefined;
    try {
      expect(env).not.toHaveProperty("WECHAT");
      expect(api.providers.storage.status).toBe("local");
      expect(ownServices.providers.storage.status).toBe("local");
      await ownChannel.ping();
      const make = createFactories({ db: livePrisma, clock: liveClock });
      const user = await make.merchantUser();
      const entity = await make.entity({ createdByUserId: user.id });
      const store = await make.store({ entityId: entity.id });
      const ownActor = {
        identity: createIdentityContext({
          actor: { type: "merchant", id: user.id, client: "weapp", role: "owner" },
          entityId: entity.id,
          storeId: store.id,
        }),
        merchant: { standing: "owner" as const, entityId: entity.id, storeId: store.id },
      };
      const body = phonePng();
      const file = (
        await api.media.register(ownActor, {
          category: "profile_image",
          files: [{ fileName: `${runId}.png`, sizeBytes: String(body.length), clientToken: runId }],
        })
      ).items[0]!;
      expect(file.mode).toBe("post");
      if (!file.post) throw new Error("小文件注册未返回POST字段");
      // register 生成自己的 UUID 文件目录和对象名；共享固定桶里只触碰这两个完整键。
      expect(file.key).toMatch(new RegExp(`^incoming/${file.fileId}/[a-f0-9-]+\\.png$`));
      const row = await livePrisma.fileObject.findUniqueOrThrow({ where: { id: file.fileId } });
      created.push({ bucket: "asset", key: file.key }, { bucket: "asset", key: row.objectKey });
      expect(row.objectKey).toMatch(new RegExp(`^profile_image/${store.id}/[a-f0-9-]+\\.png$`));
      expect(new URL(file.post.url).origin).toBe(publicOrigin);
      const form = new FormData();
      for (const [name, value] of Object.entries(file.post.fields)) form.set(name, value);
      form.set("file", new Blob([body], { type: "image/png" }), "photo.png");
      const uploaded = await fetch(file.post.url, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(10_000),
      });
      expect(uploaded.status).toBe(204);
      await uploaded.body?.cancel();
      ownWorker.consumers.media_job.start();
      // complete 自己创建 media_job 并唤醒 BullMQ；测试不调用入库、补偿扫描或入队接口。
      await api.media.complete(ownActor, file.fileId);
      await expect
        .poll(async () => (await api.media.getMerchant(ownActor, file.fileId)).status, {
          timeout: 10_000,
          interval: 50,
        })
        .toBe("stored");
      expect(
        await livePrisma.mediaJob.findUniqueOrThrow({
          where: { dedupeKey: `promote:${file.fileId}` },
        }),
      ).toMatchObject({ state: "succeeded", attemptNo: 1 });
      expect(
        await livePrisma.outboxEvent.count({
          where: { eventType: "file.stored", aggregateId: file.fileId },
        }),
      ).toBe(1);
      const signed = await api.media.signRead({ fileId: file.fileId, audience: "merchant" });
      expect(new URL(signed.url).origin).toBe(publicOrigin);
      const read = await fetch(signed.url, { signal: AbortSignal.timeout(10_000) });
      expect(read.status).toBe(200);
      expect(read.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(body);
    } finally {
      const closed = await Promise.allSettled([ownWorker.stop()]);
      closed.push(
        ...(await Promise.allSettled([
          ownChannel.close(),
          ...created.map(async (ref) => {
            expect(await api.providers.storage.delete(ref)).toMatchObject({ ok: true });
          }),
        ])),
      );
      closed.push(...(await Promise.allSettled([api.close()])));
      closeStorage(api.providers.storage);
      closeStorage(ownServices.providers.storage);
      cleanupFailure = closed.find((result) => result.status === "rejected");
    }
    if (cleanupFailure) throw cleanupFailure.reason;
  },
  30_000,
);
