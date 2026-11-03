import { createSessionMutexConnectionFactory } from "@liyoxi/db";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createSessionMutex } from "../kernel/index.js";
import { failed } from "../providers/types.js";
import {
  createZipPackageFixture,
  configTestStaffBriefs,
  useSeededDatabase,
} from "../testing/index.js";
import { createMedia } from "./index.js";
import type { RetentionOptions } from "./index.js";
import { invalidateZipBundles, readCancelZipTargets } from "./cancel-zip.js";
import { ZipInputSchema } from "./zip-types.js";

const db = useSeededDatabase("services", { label: "zipcleanup" });
let h: ReturnType<typeof createZipPackageFixture>, steps: ReturnType<typeof h.releaseSteps>;
let mutex: ReturnType<typeof createSessionMutex>,
  releaseId: string,
  jobId: string,
  used = false;
const extra: ReturnType<typeof createMedia>[] = [];
const notices: unknown[] = [];
const DAY = 86_400_000;
const retention = (): RetentionOptions => ({
  sessionMutex: mutex,
  staffBriefs: configTestStaffBriefs,
  alerts: {
    raise: async (notice) => {
      notices.push(notice);
    },
  },
  sweep: {
    parameters: async () => ({ mode: "auto", maxObjects: 500, maxBytes: 53_687_091_200n }),
    remindDemand: async () => {
      throw new Error("unexpected asset demand in ZIP fixture");
    },
  },
});
beforeAll(async () => {
  mutex = createSessionMutex({
    connect: createSessionMutexConnectionFactory({ connectionString: await db.url() }),
    maxConcurrent: 1,
    probeMs: 50,
  });
  h = createZipPackageFixture(await db.prisma(), { retention: retention() });
  h.fake.storage.capabilities.versioning = true;
  steps = h.releaseSteps();
});
beforeAll(() => steps.prepare());
beforeAll(() => steps.sampleFile());
beforeAll(() => steps.confirmSample());
beforeAll(() => steps.finalEpisode(2));
beforeAll(async () => {
  const prepared = await steps.push();
  await h.retainPreparedAgreement(prepared.o.order.agreementConsentId!);
  releaseId = prepared.release.deliveryReleaseId;
});
beforeEach(async () => {
  if (used) {
    const previous = await intents();
    const artifactIds = previous.flatMap((intent) => [
      intent.zipFileId,
      ...(intent.publishListFileId ? [intent.publishListFileId] : []),
    ]);
    // Every preceding case must reclaim its own pending intents before sharing the sweep scope.
    expect(
      await h.prisma.fileObject.count({
        where: { id: { in: artifactIds }, status: "pending" },
      }),
    ).toBe(0);
    h.clock.advance(DAY);
    await h.tx.run(async (tx) =>
      invalidateZipBundles(tx, await readCancelZipTargets(tx, [releaseId]), h.clock.now(), {
        preserveReleaseFiles: true,
      }),
    );
    const input = await h.input(releaseId);
    await h.tx.run((tx) => h.zipMedia.ensureZip(tx, input));
  }
  used = true;
  const bundle = await h.prisma.zipBundle.findUniqueOrThrow({
    where: { ownerType_ownerId: { ownerType: "delivery_release", ownerId: releaseId } },
  });
  jobId = (
    await h.prisma.mediaJob.findFirstOrThrow({
      where: { parentId: bundle.id },
      orderBy: { id: "desc" },
    })
  ).id;
  h.fake.storage.resetCalls();
  notices.length = 0;
});
afterAll(async () => {
  for (const media of extra) await media.jobs.shutdown();
  await h?.close();
  await mutex?.close();
});
const row = () => h.prisma.mediaJob.findUniqueOrThrow({ where: { id: jobId } });
const file = (id: string) => h.prisma.fileObject.findUniqueOrThrow({ where: { id } });
async function intents() {
  return ZipInputSchema.parse((await row()).input).artifactIntents!;
}
function restarted() {
  const media = createMedia({
    tx: h.tx,
    clock: h.clock,
    assembly: h.assembly,
    events: h.events,
    storage: h.zipStorage,
    zipProvider: h.fake.media,
    assets: h.zipAssets,
    retention: retention(),
  });
  extra.push(media);
  return media;
}
const sweep = (media: ReturnType<typeof createMedia>) =>
  media.retention.sweep({
    scheduledFor: h.clock.now(),
    signal: new AbortController().signal,
    runTx: h.tx.run,
  });
async function finish() {
  h.clock.set((await row()).nextRunAt);
  await h.zipMedia.jobs.run({ jobId });
  expect(await row()).toMatchObject({ state: "submitted" });
  h.clock.set((await row()).nextRunAt);
  await h.zipMedia.jobs.run({ jobId });
  expect(await row()).toMatchObject({ state: "succeeded" });
}
it("清单PUT成功后HEAD故障，下一attempt成功仍保留旧intent，新实例sweep按原流程清理", async () => {
  const original = h.zipStorage.head;
  let injected = false;
  h.zipStorage.head = async (input) => {
    if (!injected && input.key.endsWith(".txt")) {
      injected = true;
      return failed("unavailable", "fixture lost HEAD");
    }
    return original(input);
  };
  try {
    await h.zipMedia.jobs.run({ jobId });
  } finally {
    h.zipStorage.head = original;
  }
  expect(await row()).toMatchObject({
    state: "queued",
    attemptNo: 1,
    errorCode: "ZIP_LIST_UPLOAD_FAILED",
  });
  const old = (await intents())[0]!,
    list = await file(old.publishListFileId!);
  expect(list).toMatchObject({ status: "pending", storedAt: null, uploadExpiresAt: null });
  expect(h.fake.storage.objects.has(`media/${list.objectKey}`)).toBe(true);
  await finish();
  expect(await intents()).toHaveLength(2);
  expect(await sweep(restarted())).toMatchObject({ zipArtifacts: 1, failed: [] });
  expect(await file(list.id)).toMatchObject({ status: "deleted" });
  expect(await file(old.zipFileId)).toMatchObject({ status: "expired", storedAt: null });
  expect(await h.fake.storage.head({ bucket: "media", key: list.objectKey })).toMatchObject({
    ok: true,
    value: { exists: false },
  });
});
it("清单PUT应答未知保留每attempt；单候选HEAD故障不阻塞后续清理", async () => {
  const original = h.zipStorage.putStream;
  h.zipStorage.putStream = async (input) => {
    const result = await original(input);
    return input.key.endsWith(".txt") && result.ok
      ? failed("unavailable", "fixture lost PUT reply")
      : result;
  };
  try {
    await h.zipMedia.jobs.run({ jobId });
    h.clock.set((await row()).nextRunAt);
    await h.zipMedia.jobs.run({ jobId });
  } finally {
    h.zipStorage.putStream = original;
  }
  expect(await row()).toMatchObject({ state: "queued", attemptNo: 2 });
  const pending = await intents();
  expect(pending).toHaveLength(2);
  const lists = await Promise.all(pending.map((intent) => file(intent.publishListFileId!)));
  for (const list of lists) {
    expect(list.status).toBe("pending");
    expect(h.fake.storage.objects.has(`media/${list.objectKey}`)).toBe(true);
  }
  h.clock.set((await row()).deadlineAt);
  await h.zipMedia.jobs.run({ jobId });
  expect(await row()).toMatchObject({ state: "failed", errorCode: "MEDIA_JOB_EXHAUSTED" });
  const media = restarted(),
    head = h.zipStorage.head;
  h.zipStorage.head = async (input) =>
    input.key === lists[0]!.objectKey
      ? failed("unavailable", "first cleanup candidate unavailable")
      : head(input);
  try {
    expect(await sweep(media)).toMatchObject({ failed: ["zipArtifacts"] });
  } finally {
    h.zipStorage.head = head;
  }
  expect(await file(lists[0]!.id)).toMatchObject({ status: "pending", uploadExpiresAt: null });
  expect(await file(lists[1]!.id)).toMatchObject({ status: "deleted" });
  h.clock.advance(DAY);
  expect(await sweep(media)).toMatchObject({ zipArtifacts: 1, failed: [] });
  expect(await file(lists[0]!.id)).toMatchObject({ status: "deleted" });
  for (const list of lists)
    expect(
      h.fake.storage
        .callsOf("putStream")
        .filter((call) => (call.input as { key: string }).key === list.objectKey),
    ).toHaveLength(1);
});
it("提交应答丢失后超过业务deadline，sweep找回云任务，晚到产物仅在真实终态后清除", async () => {
  const pack = h.fake.media.pack;
  h.fake.media.pack = async (input) => {
    const result = await pack(input);
    return result.ok ? failed("unavailable", "fixture lost accepted ZIP reply") : result;
  };
  try {
    await h.zipMedia.jobs.run({ jobId });
  } finally {
    h.fake.media.pack = pack;
  }
  expect(await row()).toMatchObject({ state: "submitting", attemptNo: 1 });
  const intent = (await intents())[0]!,
    zip = await file(intent.zipFileId);
  expect(intent).toMatchObject({ zipSubmit: "unknown", externalJobId: null });
  const remote = h.fake.media.jobs.find((one) => one.userData === `${jobId}:1`)!;
  const bytes = h.fake.storage.objects.get(`media/${zip.objectKey}`)!;
  h.fake.storage.objects.delete(`media/${zip.objectKey}`);
  remote.state = "submitted";
  h.clock.set((await row()).deadlineAt);
  await h.zipMedia.jobs.run({ jobId });
  expect(await row()).toMatchObject({ state: "failed", errorCode: "MEDIA_JOB_EXHAUSTED" });
  const recovered = restarted();
  const finds = h.fake.media.callsOf("find").length;
  expect(await sweep(recovered)).toMatchObject({ zipArtifacts: 0, failed: [] });
  expect(h.fake.media.callsOf("find")).toHaveLength(finds + 1);
  expect((await intents())[0]).toMatchObject({
    zipSubmit: "submitted",
    externalJobId: remote.jobId,
  });
  expect(await file(zip.id)).toMatchObject({
    status: "pending",
    storedAt: null,
    uploadExpiresAt: null,
  });
  h.fake.storage.objects.set(`media/${zip.objectKey}`, bytes);
  expect(await sweep(recovered)).toMatchObject({ zipArtifacts: 0, failed: [] });
  expect(await file(zip.id)).toMatchObject({ status: "pending" });
  expect(
    h.fake.storage
      .callsOf("delete")
      .filter((call) => (call.input as { key: string }).key === zip.objectKey),
  ).toHaveLength(0);
  remote.state = "done";
  h.clock.advance(DAY);
  expect(await sweep(recovered)).toMatchObject({ zipArtifacts: 1, failed: [] });
  expect(await file(zip.id)).toMatchObject({ status: "deleted" });
  expect((await intents())[0]).toMatchObject({
    zipSubmit: "terminal",
    externalJobId: remote.jobId,
  });
  const bundle = await h.prisma.zipBundle.findUniqueOrThrow({
    where: { id: (await row()).parentId! },
  });
  expect(bundle).toMatchObject({ zipState: "failed", zipFileId: null, publishListFileId: null });
  expect(
    await h.prisma.outboxEvent.count({
      where: {
        aggregateId: bundle.id,
        eventType: "media.release.zip_ready",
        payload: { path: ["zipGen"], equals: bundle.zipGen },
      },
    }),
  ).toBe(0);
});

it("HEAD已通过但清单read失败后自动queued，旧stored清单立即释放且保持building", async () => {
  h.fake.storage.failNext("readObject");
  await h.zipMedia.jobs.run({ jobId });
  expect(await row()).toMatchObject({
    state: "queued",
    attemptNo: 1,
    errorCode: "ZIP_LIST_UPLOAD_FAILED",
  });
  const intent = (await intents())[0]!,
    list = await file(intent.publishListFileId!);
  expect(list).toMatchObject({ status: "stored", purgeAfter: h.clock.now() });
  expect(
    await h.prisma.fileRef.findFirstOrThrow({ where: { fileId: list.id, refType: "zip_bundle" } }),
  ).toMatchObject({ state: "released", keepUntil: h.clock.now() });
  expect(
    await h.prisma.zipBundle.findUniqueOrThrow({ where: { id: (await row()).parentId! } }),
  ).toMatchObject({ zipState: "building" });
  await finish();
  expect(await sweep(restarted())).toMatchObject({ failed: [] });
  expect(await file(list.id)).toMatchObject({ status: "deleted" });
});
