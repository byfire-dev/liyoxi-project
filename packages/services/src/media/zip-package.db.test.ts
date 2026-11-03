import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import {
  useSeededDatabase,
  createZipPackageFixture,
  inspectZipFixture,
  zipFixtureCrc64,
} from "../testing/index.js";
import { createIdempotencyContext, uuidv7 } from "../kernel/index.js";
import { readCancelZipTargets, invalidateZipBundles } from "./cancel-zip.js";

const db = useSeededDatabase("services");
let h: ReturnType<typeof createZipPackageFixture>;
let steps: ReturnType<typeof h.releaseSteps>;
let delivered: Awaited<ReturnType<typeof steps.push>>;
let used = false;
beforeAll(async () => {
  h = createZipPackageFixture(await db.prisma());
  steps = h.releaseSteps();
});
beforeAll(() => steps.prepare());
beforeAll(() => steps.sampleFile());
beforeAll(() => steps.confirmSample());
beforeAll(() => steps.finalEpisode(2));
beforeAll(async () => {
  delivered = await steps.push();
});
afterAll(async () => {
  await h?.close();
});
const jobFor = (bundleId: string) =>
  h.prisma.mediaJob.findFirstOrThrow({
    where: { parentId: bundleId, kind: "zip_package" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
async function setup() {
  const input = await h.input(delivered.release.deliveryReleaseId);
  if (used) {
    await h.tx.run(async (tx) =>
      invalidateZipBundles(tx, await readCancelZipTargets(tx, [input.ownerId]), h.clock.now(), {
        preserveReleaseFiles: true,
      }),
    );
    const old = await h.prisma.zipBundle.findUniqueOrThrow({
      where: { ownerType_ownerId: { ownerType: "delivery_release", ownerId: input.ownerId } },
    });
    for (const job of await h.prisma.mediaJob.findMany({
      where: { parentId: old.id, state: { in: ["queued", "submitting", "submitted"] } },
    })) {
      if (job.nextRunAt > h.clock.now()) h.clock.set(job.nextRunAt);
      await h.zipMedia.jobs.run({ jobId: job.id });
    }
    await h.tx.run((tx) => h.zipMedia.ensureZip(tx, input));
  }
  used = true;
  const bundle = await h.prisma.zipBundle.findUniqueOrThrow({
    where: {
      ownerType_ownerId: { ownerType: "delivery_release", ownerId: input.ownerId },
    },
  });
  return {
    delivered,
    input,
    bundle,
    job: await jobFor(bundle.id),
    jobCount: await h.prisma.mediaJob.count({ where: { parentId: bundle.id } }),
    refIds: (
      await h.prisma.fileRef.findMany({
        where: { refType: "zip_bundle", refId: bundle.id },
        select: { id: true },
      })
    ).map((ref) => ref.id),
    eventCount: await h.prisma.outboxEvent.count({
      where: { aggregateId: bundle.id, eventType: "media.release.zip_ready" },
    }),
  };
}
let f: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  f = await setup();
});
async function finish(jobId: string) {
  await h.zipMedia.jobs.run({ jobId });
  const submitted = await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: jobId } });
  expect(submitted.state).toBe("submitted");
  h.clock.set(submitted.nextRunAt);
  await h.zipMedia.jobs.run({ jobId });
  expect(await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({
    state: "succeeded",
  });
}
it("真实推包同事务预排一个任务，完整ZIP/清单与CRC实物经回查安装，peek延两个引用", async () => {
  expect(f.bundle).toMatchObject({ zipState: "building", zipGen: 1, zipFileId: null });
  expect(f.jobCount).toBe(1);
  expect(f.refIds).toEqual([]);
  expect(f.eventCount).toBe(0);
  expect(f.job).toMatchObject({
    state: "queued",
    attemptNo: 0,
    dedupeKey: `zip:${f.bundle.id}:${f.bundle.zipGen}`,
  });
  for (let index = 0; index < 2; index++) await h.tx.run((tx) => h.zipMedia.ensureZip(tx, f.input));
  expect(await h.prisma.mediaJob.count({ where: { parentId: f.bundle.id } })).toBe(f.jobCount);
  await finish(f.job.id);
  const ready = await h.tx.run((tx) => h.zipMedia.ensureZip(tx, f.input, { peek: true }));
  expect(ready).toMatchObject({ zipState: "ready", zipGen: f.bundle.zipGen });
  const file = await h.prisma.fileObject.findUniqueOrThrow({ where: { id: ready.zipFileId! } });
  const body = h.fake.storage.objects.get(`media/${file.objectKey}`)!.body;
  expect(file.crc64).toBe(zipFixtureCrc64(body));
  expect(inspectZipFixture(body)).toEqual({
    fileCount: 3,
    truncated: false,
    entries: [
      ...f.input.items.map((item) => ({ name: item.name, sizeBytes: item.size })),
      { name: "发布清单.txt", sizeBytes: String(Buffer.byteLength(f.input.publishListText!)) },
    ],
  });
  const keepUntil = new Date(f.input.keepUntil.getTime() + 86_400_000);
  expect(
    await h.tx.run((tx) =>
      h.zipMedia.ensureZip(tx, { ...f.input, keepUntil }, { peek: true, retry: true }),
    ),
  ).toEqual(ready);
  const refs = await h.prisma.fileRef.findMany({
    where: { refType: "zip_bundle", refId: f.bundle.id, id: { notIn: f.refIds } },
  });
  expect(refs).toHaveLength(2);
  expect(
    refs.every(
      (ref) => ref.state === "released" && ref.keepUntil?.getTime() === keepUntil.getTime(),
    ),
  ).toBe(true);
  expect(
    await h.prisma.outboxEvent.count({
      where: { aggregateId: f.bundle.id, eventType: "media.release.zip_ready" },
    }),
  ).toBe(f.eventCount + 1);
});
it("peek无行不写，peek优先retry；失败轮询不重打，人工重试新代新键", async () => {
  const untouched = { ...f.input, ownerId: uuidv7() };
  expect(
    await h.tx.run((tx) => h.zipMedia.ensureZip(tx, untouched, { peek: true, retry: true })),
  ).toEqual({
    zipBundleId: null,
    zipGen: null,
    zipState: "none",
    zipFileId: null,
    publishListFileId: null,
  });
  h.fake.storage.failNext("putStream", { reason: "unsupported" });
  await h.zipMedia.jobs.run({ jobId: f.job.id });
  const failed = await h.tx.run((tx) => h.zipMedia.ensureZip(tx, f.input));
  expect(failed).toMatchObject({
    zipState: "failed",
    zipGen: f.bundle.zipGen,
    zipFileId: null,
    publishListFileId: null,
  });
  expect(
    await h.tx.run((tx) => h.zipMedia.ensureZip(tx, f.input, { retry: true, peek: true })),
  ).toEqual(failed);
  expect(await h.prisma.mediaJob.count({ where: { parentId: f.bundle.id } })).toBe(f.jobCount);
  const retried = await h.tx.run((tx) => h.zipMedia.ensureZip(tx, f.input, { retry: true }));
  expect(retried).toMatchObject({ zipState: "building", zipGen: f.bundle.zipGen + 1 });
  await finish((await jobFor(f.bundle.id)).id);
});
it("自动可重试上传失败保持building，原退避到期后新attempt唯一目标", async () => {
  h.fake.storage.failNext("putStream");
  await h.zipMedia.jobs.run({ jobId: f.job.id });
  const retry = await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: f.job.id } });
  expect(retry).toMatchObject({
    state: "queued",
    attemptNo: 1,
    errorCode: "ZIP_LIST_UPLOAD_FAILED",
  });
  expect(await h.tx.run((tx) => h.zipMedia.ensureZip(tx, f.input))).toMatchObject({
    zipState: "building",
    zipGen: f.bundle.zipGen,
  });
  h.clock.set(retry.nextRunAt);
  await finish(f.job.id);
  const ready = await h.tx.run((tx) => h.zipMedia.ensureZip(tx, f.input));
  expect(
    (await h.prisma.fileObject.findUniqueOrThrow({ where: { id: ready.zipFileId! } })).objectKey,
  ).toContain(`/${f.job.id}-2.zip`);
});
it("缺失结果、错误目标/数量和截断/少集/错大小目录均拒绝ready并释放产物", async () => {
  const faults = [
    "missing_result",
    "wrong_key",
    "wrong_count",
    "errors",
    "truncated",
    "missing_episode",
    "wrong_size",
  ] as const;
  for (const fault of faults) {
    if (fault !== faults[0])
      await h.tx.run((tx) => h.zipMedia.ensureZip(tx, f.input, { retry: true }));
    const job = await jobFor(f.bundle.id);
    await h.zipMedia.jobs.run({ jobId: job.id });
    const remote = h.fake.media.jobs.find((entry) => entry.userData === `${job.id}:1`)!;
    const key = remote.output!.zip!.dst.key,
      preview = h.fake.media.zipPreviews.get(`media/${key}`)!;
    if (fault === "missing_result") remote.output = {};
    else if (fault === "wrong_key")
      remote.output = {
        zip: { ...remote.output!.zip!, dst: { bucket: "media", key: `${key}.other` } },
      };
    else if (fault === "wrong_count")
      remote.output = { zip: { ...remote.output!.zip!, fileCount: 1 } };
    else if (fault === "errors") remote.output = { zip: { ...remote.output!.zip!, errorCount: 1 } };
    else
      h.fake.media.zipPreviews.set(
        `media/${key}`,
        fault === "truncated"
          ? { ...preview, truncated: true }
          : fault === "missing_episode"
            ? { ...preview, entries: preview.entries.slice(1) }
            : {
                ...preview,
                entries: preview.entries.map((entry, index) =>
                  index ? entry : { ...entry, sizeBytes: "1" },
                ),
              },
      );
    h.clock.set((await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).nextRunAt);
    await h.zipMedia.jobs.run({ jobId: job.id });
    expect(await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      state: "failed",
      errorCode: ["truncated", "missing_episode", "wrong_size"].includes(fault)
        ? "ZIP_CONTENTS_INVALID"
        : "ZIP_RESULT_INVALID",
    });
    expect(await h.tx.run((tx) => h.zipMedia.ensureZip(tx, f.input))).toMatchObject({
      zipState: "failed",
      zipFileId: null,
    });
  }
  const refs = await h.prisma.fileRef.findMany({
    where: { refType: "zip_bundle", refId: f.bundle.id, id: { notIn: f.refIds } },
  });
  expect(refs).toHaveLength(faults.length * 2);
  expect(refs.every((ref) => ref.state === "released" && ref.keepUntil! <= h.clock.now())).toBe(
    true,
  );
});
it("清单已删除时ready不返回旧listId；ZIP已删除peek保留身份不写，新请求才重建", async () => {
  await finish(f.job.id);
  const before = await h.tx.run((tx) => h.zipMedia.ensureZip(tx, f.input));
  await h.prisma.fileObject.update({
    where: { id: before.publishListFileId! },
    data: { status: "deleted", deletedAt: h.clock.now() },
  });
  expect(await h.tx.run((tx) => h.zipMedia.ensureZip(tx, f.input, { peek: true }))).toMatchObject({
    zipState: "ready",
    publishListFileId: null,
  });
  await h.prisma.fileObject.update({
    where: { id: before.zipFileId! },
    data: { status: "deleted", deletedAt: h.clock.now() },
  });
  const row = await h.prisma.zipBundle.findUniqueOrThrow({ where: { id: f.bundle.id } });
  expect(await h.tx.run((tx) => h.zipMedia.ensureZip(tx, f.input, { peek: true }))).toEqual({
    zipBundleId: row.id,
    zipGen: row.zipGen,
    zipState: "none",
    zipFileId: null,
    publishListFileId: null,
  });
  expect(await h.prisma.zipBundle.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
  expect(await h.tx.run((tx) => h.zipMedia.ensureZip(tx, f.input))).toMatchObject({
    zipState: "building",
    zipGen: f.bundle.zipGen + 1,
  });
});
it("源对象不可读、缺预览能力和ZIP缺CRC均受控失败，不能安装ready", async () => {
  const sourceKey = `media/${f.input.items[0]!.key}`;
  const source = h.fake.storage.objects.get(sourceKey)!;
  h.fake.storage.objects.delete(sourceKey);
  try {
    await h.zipMedia.jobs.run({ jobId: f.job.id });
    expect(await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({
      state: "failed",
      errorCode: "ZIP_SOURCE_CHANGED",
    });
  } finally {
    h.fake.storage.objects.set(sourceKey, source);
  }
  await h.tx.run((tx) => h.zipMedia.ensureZip(tx, f.input, { retry: true }));
  const unsupported = await jobFor(f.bundle.id),
    preview = h.fake.media.previewZip!;
  delete h.fake.media.previewZip;
  try {
    await h.zipMedia.jobs.run({ jobId: unsupported.id });
    expect(
      await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: unsupported.id } }),
    ).toMatchObject({
      state: "failed",
      errorCode: "MEDIA_PROVIDER_UNSUPPORTED",
    });
  } finally {
    h.fake.media.previewZip = preview;
  }
  await h.tx.run((tx) => h.zipMedia.ensureZip(tx, f.input, { retry: true }));
  const noCrc = await jobFor(f.bundle.id);
  await h.zipMedia.jobs.run({ jobId: noCrc.id });
  const originalHead = h.zipStorage.head;
  h.zipStorage.head = async (input) => {
    const result = await originalHead(input);
    if (!result.ok || !result.value.exists || !input.key.endsWith(".zip")) return result;
    const value = { ...result.value };
    delete value.crc64;
    return { ...result, value };
  };
  try {
    h.clock.set((await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: noCrc.id } })).nextRunAt);
    await h.zipMedia.jobs.run({ jobId: noCrc.id });
    expect(await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: noCrc.id } })).toMatchObject({
      state: "failed",
      errorCode: "ZIP_RESULT_INVALID",
    });
    expect(await h.tx.run((tx) => h.zipMedia.ensureZip(tx, f.input))).toMatchObject({
      zipState: "failed",
      zipFileId: null,
    });
  } finally {
    h.zipStorage.head = originalHead;
  }
});
it("正式清单修订使缓存即时过期但保留成片；旧代结果不得安装", async () => {
  await finish(f.job.id);
  const lists = h.publishLists,
    before = await lists.get(f.delivered.qc.staff, f.delivered.id);
  await lists.replace(f.delivered.qc.ctx, f.delivered.qc.staff, f.delivered.id, {
    lockVersion: before.lockVersion,
    collectionName: before.collectionName,
    coverFileId: before.cover?.fileId ?? null,
    titleTemplate: before.titleTemplate,
    topics: before.topics,
    intro: before.intro,
    episodes: before.episodes.map((entry) => ({
      episodeNo: entry.episodeNo,
      title: `修订第${entry.episodeNo}集`,
      highlight: entry.highlight,
      topics: entry.topics,
      intro: entry.intro,
    })),
  });
  expect(await h.prisma.zipBundle.findUniqueOrThrow({ where: { id: f.bundle.id } })).toMatchObject({
    zipState: "none",
    zipGen: f.bundle.zipGen + 1,
    zipFileId: null,
  });
  expect(
    (
      await h.prisma.fileRef.findMany({
        where: { refType: "zip_bundle", refId: f.bundle.id, id: { notIn: f.refIds } },
      })
    ).every((ref) => ref.keepUntil! <= h.clock.now()),
  ).toBe(true);
  expect(
    (
      await h.prisma.fileRef.findMany({
        where: { refType: "delivery_release", refId: f.input.ownerId, role: "ep" },
      })
    ).every((ref) => ref.state === "live"),
  ).toBe(true);
  const input = await h.input(f.input.ownerId);
  await h.tx.run((tx) => h.zipMedia.ensureZip(tx, input));
  const job = await jobFor(f.bundle.id);
  await h.zipMedia.jobs.run({ jobId: job.id });
  h.clock.set((await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).nextRunAt);
  h.fake.media.delayNext("previewZip", 1000);
  const settling = h.zipMedia.jobs.run({ jobId: job.id });
  await vi.waitFor(() => expect(h.fake.media.pendingCalls()).toBe(1));
  await h.tx.run(async (tx) =>
    invalidateZipBundles(tx, await readCancelZipTargets(tx, [input.ownerId]), h.clock.now(), {
      preserveReleaseFiles: true,
    }),
  );
  expect(await h.prisma.zipBundle.findUniqueOrThrow({ where: { id: f.bundle.id } })).toMatchObject({
    zipState: "none",
    zipGen: f.bundle.zipGen + 3,
    zipFileId: null,
  });
  await h.tx.run((tx) => h.zipMedia.ensureZip(tx, input));
  const winner = await jobFor(f.bundle.id);
  h.clock.advance(1000);
  h.fake.media.tick();
  await settling;
  expect(await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
    state: "canceled",
  });
  expect(await h.prisma.zipBundle.findUniqueOrThrow({ where: { id: f.bundle.id } })).toMatchObject({
    zipState: "building",
    zipGen: f.bundle.zipGen + 4,
    zipFileId: null,
  });
  await finish(winner.id);
  expect(await h.prisma.zipBundle.findUniqueOrThrow({ where: { id: f.bundle.id } })).toMatchObject({
    zipState: "ready",
    zipGen: f.bundle.zipGen + 4,
  });
  const staleFiles = await h.prisma.fileObject.findMany({
    where: { objectKey: { contains: `/${job.id}-1.` } },
  });
  expect(staleFiles).toHaveLength(2);
  const staleRefs = await h.prisma.fileRef.findMany({
    where: { fileId: { in: staleFiles.map((file) => file.id) } },
  });
  expect(staleRefs).toHaveLength(2);
  expect(
    staleRefs.every((ref) => ref.state === "released" && ref.keepUntil! <= h.clock.now()),
  ).toBe(true);
});
it("后台pack同键精确重放、不同键读最新，已关闭release拒绝", async () => {
  const service = h.zipPackages;
  const makeIdem = () =>
    createIdempotencyContext({
      mode: "required",
      scope: "admin.deliveryRelease.pack",
      actor: f.delivered.qc.ctx.actor,
      key: `zip-${f.input.ownerId}`,
      request: { method: "POST", body: {} },
    });
  const first = await service.pack(f.delivered.qc.ctx, f.delivered.qc.staff, f.input.ownerId, {
    idem: makeIdem(),
  });
  await finish(f.job.id);
  expect(
    await service.pack(f.delivered.qc.ctx, f.delivered.qc.staff, f.input.ownerId, {
      idem: makeIdem(),
    }),
  ).toEqual(first);
  expect(
    await service.pack(f.delivered.qc.ctx, f.delivered.qc.staff, f.input.ownerId),
  ).toMatchObject({ zipState: "ready" });
  await h.prisma.deliveryRelease.update({
    where: { id: f.input.ownerId },
    data: { state: "closed", closedAt: h.clock.now(), closeReason: "cancelled" },
  });
  await expect(
    service.pack(f.delivered.qc.ctx, f.delivered.qc.staff, f.input.ownerId),
  ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
});
