import { beforeAll, afterAll, it, expect } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { harness } from "./__fixtures__/production.js";
import type { Harness } from "./__fixtures__/production.js";
import { consumeFinalReleaseBatch, recordAdoptedStoreAssets } from "./delivery-write.js";
import { uuidv7 } from "../kernel/index.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
afterAll(() => h?.unbind());
it("素材采用新增才累计/发事件，同TX失败回滚，跨门店不可采用", async () => {
  const o = await h.order(true),
    item = o.items[0]!,
    now = h.clock.now(),
    reviewer = await h.staff();
  const asset = await h.prisma.storeAsset.create({
    data: {
      id: uuidv7(),
      entityId: o.entity.id,
      storeId: o.store.id,
      type: "image",
      title: "测试素材",
      idempotencyKey: uuidv7(),
      usability: "ready",
      processingState: "processed",
      reviewState: "reviewed",
      reviewedByStaffId: reviewer.row.id,
      reviewedAt: now,
      uploadActorType: "merchant",
      uploadActorId: o.user.id,
      uploadActorRole: "owner",
      uploadClient: "weapp",
      createdAt: now,
      updatedAt: now,
    },
  });
  const input = {
    entityId: o.entity.id,
    storeId: o.store.id,
    orderItemId: item.id,
    storeAssetIds: [asset.id],
  };
  await expect(
    h.tx.run(async (tx) => {
      await recordAdoptedStoreAssets(tx, h.deps, o.viewer.ctx, input);
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect(
    (await h.prisma.storeAsset.findUniqueOrThrow({ where: { id: asset.id } })).adoptedCount,
  ).toBe(0);
  expect(await h.prisma.outboxEvent.count({ where: { aggregateId: asset.id } })).toBe(0);
  expect(
    (
      await Promise.all([
        h.tx.run((tx) => recordAdoptedStoreAssets(tx, h.deps, o.viewer.ctx, input)),
        h.tx.run((tx) => recordAdoptedStoreAssets(tx, h.deps, o.viewer.ctx, input)),
      ])
    ).sort(),
  ).toEqual([0, 1]);
  expect(await h.tx.run((tx) => recordAdoptedStoreAssets(tx, h.deps, o.viewer.ctx, input))).toBe(0);
  expect(
    (await h.prisma.storeAsset.findUniqueOrThrow({ where: { id: asset.id } })).adoptedCount,
  ).toBe(1);
  expect(
    await h.prisma.outboxEvent.count({
      where: { aggregateId: asset.id, eventType: "asset.adopted" },
    }),
  ).toBe(1);
  const other = await h.make.store({ entityId: o.entity.id });
  await expect(
    h.tx.run((tx) =>
      recordAdoptedStoreAssets(tx, h.deps, o.viewer.ctx, { ...input, storeId: other.id }),
    ),
  ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
}, 60000);
it("旧采用公口拒绝已删除、block或未完成处理/复核素材，整批没有计数或事件旁写", async () => {
  const o = await h.order(true),
    item = o.items[0]!,
    reviewer = await h.staff(),
    now = h.clock.now();
  const makeAsset = (
    extra: {
      deletedAt?: Date;
      moderationState?: string;
      processingState?: string;
      reviewState?: string;
      usability?: string | null;
      reviewedByStaffId?: string | null;
      reviewedAt?: Date | null;
    } = {},
  ) =>
    h.prisma.storeAsset.create({
      data: {
        id: uuidv7(),
        entityId: o.entity.id,
        storeId: o.store.id,
        type: "text",
        textBody: "采用守卫真实前提",
        idempotencyKey: uuidv7(),
        usability: "ready",
        processingState: "processed",
        reviewState: "reviewed",
        reviewedByStaffId: reviewer.row.id,
        reviewedAt: now,
        uploadActorType: "merchant",
        uploadActorId: o.user.id,
        uploadActorRole: "owner",
        uploadClient: "weapp",
        createdAt: now,
        updatedAt: now,
        ...extra,
      },
    });
  const valid = await makeAsset();
  const invalid = await Promise.all([
    makeAsset({ deletedAt: now }),
    makeAsset({ moderationState: "block" }),
    makeAsset({ processingState: "processing" }),
    makeAsset({
      reviewState: "unreviewed",
      usability: null,
      reviewedByStaffId: null,
      reviewedAt: null,
    }),
  ]);
  const before = await Promise.all([
    h.prisma.storeAssetUsage.count(),
    h.prisma.outboxEvent.count(),
  ]);
  for (const asset of invalid) {
    await expect(
      h.tx.run((tx) =>
        recordAdoptedStoreAssets(tx, h.deps, o.viewer.ctx, {
          entityId: o.entity.id,
          storeId: o.store.id,
          orderItemId: item.id,
          storeAssetIds: [valid.id, asset.id],
        }),
      ),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    expect(
      await Promise.all([h.prisma.storeAssetUsage.count(), h.prisma.outboxEvent.count()]),
    ).toEqual(before);
    expect(
      (await h.prisma.storeAsset.findMany({ where: { id: { in: [valid.id, asset.id] } } })).map(
        (row) => row.adoptedCount,
      ),
    ).toEqual([0, 0]);
  }
}, 60000);

it("批次持锁重校验purpose/到期/fingerprint，callback失败整批保持ready及live引用", async () => {
  const o = await h.order(true),
    item = o.items[0]!,
    staff = await h.staff(),
    now = h.clock.now();
  const batch = await h.prisma.uploadBatch.create({
    data: {
      id: uuidv7(),
      purpose: "final_release",
      aiUsage: {
        used: false,
        tools: [],
        declaredBy: staff.row.id,
        declaredAt: now.toISOString(),
        forcedByDrama: false,
      },
      targetId: item.id,
      variant: "common",
      scope: "partial",
      expectedCount: item.episodeCount,
      createdByStaffId: staff.row.id,
      state: "ready",
      idempotencyKey: uuidv7(),
      expiresAt: new Date(now.getTime() + 100000),
      createdAt: now,
      updatedAt: now,
    },
  });
  const f = await h.make.fileObject({
    category: "final_episode",
    uploadBatchId: batch.id,
    scopeType: "store",
    entityId: o.entity.id,
    storeId: o.store.id,
  });
  await h.prisma.uploadBatchItem.create({
    data: {
      id: uuidv7(),
      uploadBatchId: batch.id,
      fileId: f.id,
      originalName: "test.mp4",
      episodeNo: 1,
      matchMethod: "manual",
      state: "checked",
      createdAt: now,
      updatedAt: now,
    },
  });
  await h.tx.run((tx) =>
    h.deps.media.link(tx, {
      fileId: f.id,
      entityId: o.entity.id,
      storeId: o.store.id,
      refType: "upload_batch",
      refId: batch.id,
      role: "main",
    }),
  );
  const input = {
    entityId: o.entity.id,
    storeId: o.store.id,
    orderItemId: item.id,
    batchId: batch.id,
    expectedCount: item.episodeCount,
  };
  let callbacks = 0;
  const callback = async () => {
    callbacks++;
    throw new Error("callback rollback");
  };
  await expect(
    h.tx.run((tx) =>
      consumeFinalReleaseBatch(
        tx,
        h.deps,
        { ...input, candidateItems: [{ episodeNo: 2, fileId: f.id, variant: "common" }] },
        callback,
      ),
    ),
  ).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
  expect(callbacks).toBe(0);
  await expect(
    h.tx.run((tx) => consumeFinalReleaseBatch(tx, h.deps, input, callback)),
  ).rejects.toThrow("callback rollback");
  expect((await h.prisma.uploadBatch.findUniqueOrThrow({ where: { id: batch.id } })).state).toBe(
    "ready",
  );
  expect(await h.prisma.fileRef.count({ where: { refId: batch.id, state: "live" } })).toBe(1);
  await h.prisma.uploadBatch.update({ where: { id: batch.id }, data: { expiresAt: now } });
  await expect(
    h.tx.run((tx) => consumeFinalReleaseBatch(tx, h.deps, input, callback)),
  ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
  expect(callbacks).toBe(1);
}, 60000);
