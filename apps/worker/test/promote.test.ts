import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  buildWorkerServices,
  createMedia,
  createRuntime,
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
let services: ReturnType<typeof buildWorkerServices>;
let media: ReturnType<typeof createMedia>;
let runtime: ReturnType<typeof createWorkerRuntime>;
let fake: ReturnType<typeof createFakeProviders>;
let actor: Parameters<typeof media.register>[0];
let serviceRuntime: ReturnType<typeof createRuntime>;
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
beforeAll(async () => {
  prisma = await db.prisma();
  const make = createFactories({ db: prisma, clock });
  const assembly = assembleForTest({ entry: "worker", omitReal: ["recurringJobs"] });
  fake = createFakeProviders({ clock });
  await redis.flush();
  channel = createQueueChannel({ redisUrl: process.env.REDIS_URL!, prefix: `${redis.prefix}bull` });
  await channel.ping();
  services = buildWorkerServices({
    appEnv: "test",
    prisma,
    assembly,
    channel,
    clock,
    providers: fake,
  });
  serviceRuntime = createRuntime({
    entry: "worker",
    env: loadEnv({ ...process.env, DATABASE_URL: await db.url() }),
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
  runtime = createWorkerRuntime({ services, channel, logger: silentLogger });
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
}, 180_000);
afterAll(async () => {
  await runtime?.stop();
  await channel?.close();
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
  it("独立前缀队列被清后，30 秒扫描重唤醒，重复投递仅一个 stored 事实", async () => {
    const file = await queued();
    expect(QUEUE_CONCURRENCY.promote).toBe(2);
    await redis.flush();
    expect((await prisma.mediaJob.findUniqueOrThrow({ where: { id: file.job.id } })).state).toBe(
      "queued",
    );
    expect(await services.scanPromote()).toBe(0);
    clock.advance(30_001);
    expect(await services.scanPromote()).toBe(1);
    await channel.enqueue("promote", uuidv7(), { jobId: file.job.id });
    runtime.consumers.promote.start();
    await waitStored(file.fileId);
    await runtime.consumers.promote.pause();
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
    runtime.consumers.promote.start();
    await waitStored(file.fileId);
    await runtime.consumers.promote.pause();
    expect(await prisma.mediaJob.findUniqueOrThrow({ where: { id: file.job.id } })).toMatchObject({
      state: "succeeded",
      attemptNo: 2,
    });
  });
});
