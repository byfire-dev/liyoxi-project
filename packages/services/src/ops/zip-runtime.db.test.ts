import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { assembleForTest, useSeededDatabase, createZipPackageFixture } from "../testing/index.js";
import { buildWorkerServices } from "./worker.js";
import { invalidateZipBundles, readCancelZipTargets } from "../media/index.js";

const db = useSeededDatabase("services");
let h: ReturnType<typeof createZipPackageFixture>;
let worker: ReturnType<typeof buildWorkerServices>;
let releaseId: string, jobId: string, initialGen: number;
let steps: ReturnType<typeof h.releaseSteps>,
  used = false;
let refIds: string[], eventCount: number;
beforeAll(async () => {
  h = createZipPackageFixture(await db.prisma());
  steps = h.releaseSteps();
  worker = buildWorkerServices({
    appEnv: "test",
    prisma: h.prisma,
    clock: h.clock,
    assembly: assembleForTest({ entry: "worker" }),
    channel: { enqueue: async () => {}, downForMs: () => 0 },
    providers: { ...h.fake, storage: h.zipStorage },
  });
});
beforeAll(() => steps.prepare());
beforeAll(() => steps.sampleFile());
beforeAll(() => steps.confirmSample());
beforeAll(() => steps.finalEpisode(2));
beforeAll(async () => {
  releaseId = (await steps.push()).release.deliveryReleaseId;
});
beforeEach(async () => {
  worker.resumeMediaJobs?.();
  if (used) {
    await invalidate();
    const input = await h.input(releaseId);
    await h.tx.run((tx) => h.zipMedia.ensureZip(tx, input));
  }
  used = true;
  const bundle = await h.prisma.zipBundle.findUniqueOrThrow({
    where: {
      ownerType_ownerId: { ownerType: "delivery_release", ownerId: releaseId },
    },
  });
  jobId = (
    await h.prisma.mediaJob.findFirstOrThrow({
      where: { parentId: bundle.id, kind: "zip_package" },
      orderBy: { id: "desc" },
    })
  ).id;
  initialGen = bundle.zipGen;
  refIds = (
    await h.prisma.fileRef.findMany({
      where: { refType: "zip_bundle", refId: bundle.id },
      select: { id: true },
    })
  ).map((ref) => ref.id);
  eventCount = await h.prisma.outboxEvent.count({
    where: { aggregateId: bundle.id, eventType: "media.release.zip_ready" },
  });
  h.fake.media.resetCalls();
});
afterAll(async () => {
  await worker?.pauseMediaJobs?.();
  await worker?.shutdownMediaJobs?.();
  worker?.closeMediaJobs?.();
  await worker?.closeDocs();
  await worker?.closeNotify();
  await worker?.closeAnalytics?.();
  await worker?.closeOrder?.();
  worker?.closeBillingTimers?.();
  worker?.closePublish?.();
  worker?.closeDelivery?.();
  worker?.closeWebhooks?.();
  await worker?.closeMediaDrivers?.();
  await worker?.closeStorageDrivers?.();
  await h?.close();
});
const row = () => h.prisma.mediaJob.findUniqueOrThrow({ where: { id: jobId } });
const bundle = () =>
  h.prisma.zipBundle.findUniqueOrThrow({
    where: {
      ownerType_ownerId: { ownerType: "delivery_release", ownerId: releaseId },
    },
  });
async function next() {
  h.clock.set((await row()).nextRunAt);
  await worker.promoteFile({ jobId });
}
async function invalidate() {
  await h.tx.run(async (tx) =>
    invalidateZipBundles(tx, await readCancelZipTargets(tx, [releaseId]), h.clock.now(), {
      preserveReleaseFiles: true,
    }),
  );
}
async function acceptedWithoutResponse() {
  h.fake.media.delayNext("pack", 60_000);
  await worker.scanPromote();
  await vi.waitFor(() => {
    expect(
      h.fake.media.jobs.find((job) => job.userData === `${jobId}:1`)?.output?.zip,
    ).toBeDefined();
  });
  await worker.pauseMediaJobs?.();
  expect(h.fake.media.pendingCalls()).toBe(0);
  expect(await row()).toMatchObject({ state: "submitting", attemptNo: 1, externalJobId: null });
}
it("真实worker扫描认领、提交及原五秒回查完成ZIP，重复运输不多提交", async () => {
  expect(initialGen).toBe(1);
  const started = h.clock.now();
  await worker.scanPromote();
  await vi.waitFor(async () => expect(await row()).toMatchObject({ state: "submitted" }));
  expect((await row()).nextRunAt.getTime() - started.getTime()).toBe(5000);
  await next();
  expect(await row()).toMatchObject({ state: "succeeded", attemptNo: 1 });
  expect(await bundle()).toMatchObject({ zipState: "ready", zipGen: initialGen });
  await worker.promoteFile({ jobId });
  expect(h.fake.media.callsOf("pack")).toHaveLength(1);
  expect(h.fake.media.callsOf("describe")).toHaveLength(1);
  expect(h.fake.media.pendingCalls()).toBe(0);
});
it("暂停中止未知应答后恢复只find已受理任务，不重复制作或扩大shutdown窗口", async () => {
  await acceptedWithoutResponse();
  worker.resumeMediaJobs?.();
  await next();
  expect(await row()).toMatchObject({ state: "submitted", attemptNo: 1 });
  await next();
  expect(await row()).toMatchObject({ state: "succeeded", attemptNo: 1 });
  expect(h.fake.media.callsOf("pack")).toHaveLength(1);
  expect(h.fake.media.callsOf("find")).toHaveLength(1);
  expect(
    await h.prisma.fileRef.count({
      where: { refType: "zip_bundle", refId: (await bundle()).id, id: { notIn: refIds } },
    }),
  ).toBe(2);
});
it("未知提交后作废仍回查已受理旧代，晚到ZIP和清单只进入清理", async () => {
  await acceptedWithoutResponse();
  await invalidate();
  worker.resumeMediaJobs?.();
  await next();
  expect(await row()).toMatchObject({ state: "submitted", attemptNo: 1 });
  await next();
  expect(await row()).toMatchObject({ state: "canceled", attemptNo: 1 });
  expect(await bundle()).toMatchObject({
    zipState: "none",
    zipGen: initialGen + 1,
    zipFileId: null,
  });
  expect(h.fake.media.callsOf("pack")).toHaveLength(1);
  const refs = await h.prisma.fileRef.findMany({
    where: { refType: "zip_bundle", refId: (await bundle()).id, id: { notIn: refIds } },
  });
  expect(refs).toHaveLength(2);
  expect(refs.every((ref) => ref.state === "released" && ref.keepUntil! <= h.clock.now())).toBe(
    true,
  );
  expect(
    await h.prisma.outboxEvent.count({
      where: { aggregateId: (await bundle()).id, eventType: "media.release.zip_ready" },
    }),
  ).toBe(eventCount);
});
it("作废未知提交find无结果仍留事实至原deadline，绝不重新pack", async () => {
  h.fake.media.failNext("pack");
  await worker.promoteFile({ jobId });
  expect(await row()).toMatchObject({ state: "submitting", externalJobId: null });
  await invalidate();
  await next();
  expect(await row()).toMatchObject({ state: "submitting", attemptNo: 1 });
  h.clock.set((await row()).deadlineAt);
  await worker.promoteFile({ jobId });
  expect(await row()).toMatchObject({
    state: "failed",
    attemptNo: 1,
    errorCode: "MEDIA_JOB_EXHAUSTED",
  });
  const intent = (await row()).input as {
    artifactIntents: Array<{ zipFileId: string; zipSubmit: string }>;
  };
  expect(intent.artifactIntents[0]).toMatchObject({ zipSubmit: "unknown" });
  expect(
    await h.prisma.fileObject.findUniqueOrThrow({
      where: { id: intent.artifactIntents[0]!.zipFileId },
    }),
  ).toMatchObject({ status: "pending", uploadExpiresAt: null });
  expect(h.fake.media.callsOf("pack")).toHaveLength(1);
  expect(h.fake.media.callsOf("find")).toHaveLength(1);
  const refs = await h.prisma.fileRef.findMany({
    where: { refType: "zip_bundle", refId: (await bundle()).id, id: { notIn: refIds } },
  });
  expect(refs).toHaveLength(1);
  expect(refs[0]).toMatchObject({ role: "list", state: "released", keepUntil: h.clock.now() });
});
