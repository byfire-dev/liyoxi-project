import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createRuntime } from "../runtime.js";
import * as mediaDomain from "../media/index.js";
import { createTxRunner, loadEnv, uuidv7 } from "../kernel/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { buildWorkerServices } from "./worker.js";
const handle = useSeededDatabase("services"),
  redis = useTestRedis(),
  clock = createClock();
let db: Awaited<ReturnType<typeof handle.prisma>>;
let api: ReturnType<typeof createRuntime>, worker: ReturnType<typeof buildWorkerServices>;
let workerMedia: ReturnType<typeof mediaDomain.createMedia>;
let tx: ReturnType<typeof createTxRunner>, fileId: string;
const rows: string[] = [],
  parents: string[] = [];
const extraWorkers: ReturnType<typeof buildWorkerServices>[] = [];
let apiClosed = false;
beforeAll(async () => {
  db = await handle.prisma();
  tx = createTxRunner({ prisma: db, appEnv: "test" });
  fileId = (await createFactories({ db, clock }).fileObject()).id;
  const factory = vi.spyOn(mediaDomain, "createMedia");
  api = createRuntime({
    entry: "api",
    env: loadEnv({
      APP_ENV: "test",
      DATABASE_URL: await handle.url(),
      REDIS_URL: process.env.REDIS_URL,
    }),
    version: "fake",
    clock,
    redisKeyPrefix: redis.prefix,
  });
  worker = buildWorkerServices({
    appEnv: "test",
    prisma: db,
    clock,
    assembly: assembleForTest({ entry: "worker" }),
    channel: { enqueue: async () => {}, downForMs: () => 0 },
  });
  workerMedia = factory.mock.results.at(-1)!.value as ReturnType<typeof mediaDomain.createMedia>;
});
afterAll(async () => {
  for (const other of extraWorkers) {
    await other.shutdownMediaJobs?.();
    other.closeMediaJobs?.();
    await other.closeNotify?.();
    await other.closeAnalytics?.();
    other.closeOrder?.();
    other.closeBillingTimers?.();
    other.closePublish?.();
    other.closeDelivery?.();
    other.closeWebhooks?.();
    await Promise.all([other.closeMediaDrivers?.(), other.closeStorageDrivers?.()]);
  }
  await worker?.shutdownMediaJobs?.();
  worker?.closeMediaJobs?.();
  await worker?.closeNotify?.();
  await worker?.closeAnalytics?.();
  worker?.closeOrder?.();
  worker?.closeBillingTimers?.();
  worker?.closePublish?.();
  worker?.closeDelivery?.();
  worker?.closeWebhooks?.();
  await Promise.all([worker?.closeMediaDrivers?.(), worker?.closeStorageDrivers?.()]);
  if (!apiClosed) await api?.close();
  await db?.mediaJob.deleteMany({ where: { id: { in: rows } } });
  await db?.playableAsset.deleteMany({ where: { id: { in: parents } } });
  vi.restoreAllMocks();
});
async function expired() {
  const id = uuidv7();
  rows.push(id);
  return db.mediaJob.create({
    data: {
      id,
      kind: "digest",
      provider: "local",
      mode: "local",
      subjectType: "file_object",
      subjectId: fileId,
      dedupeKey: `w303scope:${id}`,
      state: "queued",
      input: { v: 1 },
      nextRunAt: clock.now(),
      deadlineAt: new Date(clock.now().getTime() - 1),
      createdAt: clock.now(),
      updatedAt: clock.now(),
    },
  });
}
it("API和worker实际assembly的I10/I11只使用所属执行器，关闭不回退另一scope", async () => {
  const a = vi.spyOn(api.media.jobs, "expire"),
    b = vi.spyOn(workerMedia.jobs, "expire");
  await expired();
  await tx.run((t) => api.assembly.invariant("media.I10")!.run!(t, {}, { now: clock.now() }));
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).not.toHaveBeenCalled();
  await expired();
  await tx.run((t) => worker.assembly.invariant("media.I10")!.run!(t, {}, { now: clock.now() }));
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(1);
  const makeParent = async () => {
    const id = uuidv7();
    parents.push(id);
    return db.playableAsset.create({
      data: {
        id,
        kind: "trailer",
        sourceFileId: fileId,
        ownerType: "drama",
        ownerId: uuidv7(),
        state: "processing",
        specVersion: parents.length,
        createdAt: clock.now(),
        updatedAt: new Date(clock.now().getTime() - 15 * 60_000),
      },
    });
  };
  const convergeA = vi.fn(
    async (t: Parameters<typeof api.media.jobs.expire>[0], id: string, now: Date) => {
      await t.playableAsset.update({ where: { id }, data: { state: "failed", updatedAt: now } });
    },
  );
  const convergeB = vi.fn(
    async (t: Parameters<typeof api.media.jobs.expire>[0], id: string, now: Date) => {
      await t.playableAsset.update({
        where: { id },
        data: { state: "ready", readyAt: now, updatedAt: now },
      });
    },
  );
  api.media.jobs.convergence.set("playable_asset", {
    parentType: "playable_asset",
    needed: async () => true,
    converge: convergeA,
  });
  workerMedia.jobs.convergence.set("playable_asset", {
    parentType: "playable_asset",
    needed: async () => true,
    converge: convergeB,
  });
  const parentA = await makeParent();
  await tx.run((t) => api.assembly.invariant("media.I11")!.run!(t, {}, { now: clock.now() }));
  expect(convergeA).toHaveBeenCalledTimes(1);
  expect(convergeB).not.toHaveBeenCalled();
  expect((await db.playableAsset.findUniqueOrThrow({ where: { id: parentA.id } })).state).toBe(
    "failed",
  );
  const parentB = await makeParent();
  await tx.run((t) => worker.assembly.invariant("media.I11")!.run!(t, {}, { now: clock.now() }));
  expect(convergeA).toHaveBeenCalledTimes(1);
  expect(convergeB).toHaveBeenCalledTimes(1);
  expect((await db.playableAsset.findUniqueOrThrow({ where: { id: parentB.id } })).state).toBe(
    "ready",
  );
  worker.closeMediaJobs?.();
  await expect(
    tx.run((t) => worker.assembly.invariant("media.I10")!.run!(t, {}, { now: clock.now() })),
  ).rejects.toThrow("本媒体运行时尚未绑定或已经关闭");
  await expect(
    tx.run((t) => worker.assembly.invariant("media.I11")!.run!(t, {}, { now: clock.now() })),
  ).rejects.toThrow("本媒体运行时尚未绑定或已经关闭");
  await expired();
  await tx.run((t) => api.assembly.invariant("media.I10")!.run!(t, {}, { now: clock.now() }));
  expect(a).toHaveBeenCalledTimes(2);
  expect(b).toHaveBeenCalledTimes(1);
  const peer = buildWorkerServices({
    appEnv: "test",
    prisma: db,
    clock,
    assembly: assembleForTest({ entry: "worker" }),
    channel: { enqueue: async () => {}, downForMs: () => 0 },
  });
  extraWorkers.push(peer);
  await api.close();
  apiClosed = true;
  await expect(
    tx.run((t) => api.assembly.invariant("media.I10")!.run!(t, {}, { now: clock.now() })),
  ).rejects.toThrow("本媒体运行时尚未绑定或已经关闭");
  await expect(
    tx.run((t) => api.assembly.invariant("media.I11")!.run!(t, {}, { now: clock.now() })),
  ).rejects.toThrow("本媒体运行时尚未绑定或已经关闭");
  await expired();
  await tx.run((t) => peer.assembly.invariant("media.I10")!.run!(t, {}, { now: clock.now() }));
  expect(await db.mediaJob.count({ where: { id: { in: rows }, state: "queued" } })).toBe(0);
});
