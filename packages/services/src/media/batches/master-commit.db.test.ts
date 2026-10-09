import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "../../kernel/index.js";
import { useSeededDatabase } from "../../testing/index.js";
import { batchDraft, batchHarness, MP4_HEADER } from "./batch-test.fixture.js";

const db = useSeededDatabase("services", { label: "batchmaster" });
type Harness = Awaited<ReturnType<typeof batchHarness>>;
const owned: Harness[] = [];
const episodeNos = Array.from({ length: 20 }, (_, index) => index + 1);
const sha256 = createHash("sha256").update(MP4_HEADER).digest("hex");
const retentionMs = 180 * 86_400_000;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of owned.splice(0).reverse()) await h.media.jobs.shutdown();
});

/**
 * Commit-service unit fixtures only: stored objects, media facts, checks and ready state
 * are explicitly arranged in this isolated database. The header bytes are not a real
 * playable video. These tests do not establish probe, worker or browser readiness.
 */
async function readyMasters() {
  const h = await batchHarness(await db.prisma());
  owned.push(h);
  const staffId = h.actor.identity.actor.id;
  if (!staffId) throw new Error("The fixture requires a real staff actor");
  const now = h.clock.now();
  const oldFile = await h.make.fileObject({
    category: "drama_master",
    bucket: "media",
    ext: "mp4",
    declaredMime: "video/mp4",
    mime: "video/mp4",
    declaredSize: BigInt(MP4_HEADER.length),
    sizeBytes: BigInt(MP4_HEADER.length),
    sha256,
  });
  h.fake.storage.put({ bucket: "media", key: oldFile.objectKey }, MP4_HEADER, "video/mp4");
  const old = await h.prisma.dramaEpisodeMaster.create({
    data: {
      id: uuidv7(),
      dramaId: h.drama.id,
      episodeNo: 1,
      revNo: 5,
      fileId: oldFile.id,
      state: "ready",
      isCurrent: true,
      durationMs: 20_000,
      createdByStaffId: staffId,
      activatedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  await h.tx.run((tx) =>
    h.media.link(tx, {
      fileId: oldFile.id,
      entityId: null,
      storeId: null,
      refType: "drama_episode_master",
      refId: old.id,
      role: "main",
    }),
  );
  const body = {
    ...h.body(
      episodeNos.map((no) => batchDraft(`第${no}集.mp4`)),
      "full",
    ),
    replaceReason: "quality_fix",
    isContentChanged: true,
  };
  const batch = await h.media.uploadBatches.create(h.actor, body, h.options("create", body));
  await h.media.uploadBatches.start(
    h.actor,
    batch.uploadBatchId,
    {},
    h.options("start", {}, undefined, batch.uploadBatchId),
  );
  for (const item of batch.items) {
    const file = await h.prisma.fileObject.findUniqueOrThrow({ where: { id: item.fileId } });
    const etag = h.fake.storage.put(
      { bucket: "media", key: file.objectKey },
      MP4_HEADER,
      "video/mp4",
    );
    await h.prisma.fileObject.update({
      where: { id: item.fileId },
      data: {
        status: "stored",
        incomingKey: null,
        incomingBucket: null,
        sizeBytes: BigInt(MP4_HEADER.length),
        mime: "video/mp4",
        etag,
        sha256,
        storedAt: now,
        updatedAt: now,
      },
    });
    await h.prisma.mediaInfo.create({
      data: {
        fileId: item.fileId,
        kind: "video",
        container: "mp4",
        durationMs: 20_000 + item.episodeNo!,
        width: 720,
        height: 1280,
        displayWidth: 720,
        displayHeight: 1280,
        vcodec: "h264",
        probeVersion: 1,
        raw: { fixture: "commit-service-unit" },
        probedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    await h.prisma.mediaCheck.create({
      data: {
        fileId: item.fileId,
        profile: "master",
        ruleVersion: 1,
        gate: "pass",
        hard: [],
        soft: [],
        checkedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  await h.tx.run(async (tx) => {
    for (const item of [...batch.items].sort((a, b) => a.fileId.localeCompare(b.fileId)))
      await h.media.link(tx, {
        fileId: item.fileId,
        entityId: null,
        storeId: null,
        refType: "upload_batch",
        refId: batch.uploadBatchId,
        role: "main",
      });
  });
  await h.prisma.uploadBatchItem.updateMany({
    where: { uploadBatchId: batch.uploadBatchId },
    data: { state: "checked", updatedAt: now },
  });
  await h.prisma.uploadBatch.update({
    where: { id: batch.uploadBatchId },
    data: { state: "ready", updatedAt: now },
  });
  h.clock.advance(5_000);
  return { h, batch, old, oldFile };
}

async function projection(fixture: Awaited<ReturnType<typeof readyMasters>>) {
  const { h, batch, oldFile } = fixture;
  const fileIds = [...batch.items.map((item) => item.fileId), oldFile.id];
  const [batchRow, items, masters, refs, files, events, audits] = await Promise.all([
    h.prisma.uploadBatch.findUniqueOrThrow({ where: { id: batch.uploadBatchId } }),
    h.prisma.uploadBatchItem.findMany({
      where: { uploadBatchId: batch.uploadBatchId },
      orderBy: { id: "asc" },
    }),
    h.prisma.dramaEpisodeMaster.findMany({
      where: { dramaId: h.drama.id },
      orderBy: [{ episodeNo: "asc" }, { revNo: "asc" }],
    }),
    h.prisma.fileRef.findMany({
      where: { fileId: { in: fileIds } },
      orderBy: { id: "asc" },
    }),
    h.prisma.fileObject.findMany({ where: { id: { in: fileIds } }, orderBy: { id: "asc" } }),
    h.prisma.outboxEvent.findMany({
      where: {
        aggregateType: "drama",
        aggregateId: h.drama.id,
        eventType: "drama.masters_changed",
      },
      orderBy: { seq: "asc" },
    }),
    h.prisma.auditLog.findMany({
      where: { targetType: "drama", targetId: h.drama.id, action: "media.batch.commit" },
      orderBy: { seq: "asc" },
    }),
  ]);
  return { batchRow, items, masters, refs, files, events, audits };
}

describe("原片批次公开提交与原子交接", { timeout: 60_000 }, () => {
  it("完整20集建立当前版本、保留旧引用180天，同幂等键重放不新增版本或事件", async () => {
    const fixture = await readyMasters();
    const { h, batch, old } = fixture;
    expect(await h.media.uploadBatches.get(h.actor, batch.uploadBatchId)).toMatchObject({
      state: "ready",
      scope: "full",
      expectedCount: 20,
      counts: { total: 20, checked: 20 },
      coverage: { missingEpisodeNos: [], duplicateEpisodeNos: [], unmatchedItemIds: [] },
    });
    const key = uuidv7();
    const commit = () =>
      h.media.uploadBatches.commit(
        h.actor,
        batch.uploadBatchId,
        {},
        h.options("commit", {}, key, batch.uploadBatchId),
      );
    const now = h.clock.now();
    const result = await commit();
    expect(result.batch).toMatchObject({
      state: "committed",
      expectedCount: 20,
      committedAt: now.toISOString(),
    });
    expect(result.masters.map((master) => master.episodeNo)).toEqual(episodeNos);
    expect(result.masters.map((master) => master.revNo)).toEqual([6, ...Array<number>(19).fill(1)]);
    const after = await projection(fixture);
    expect(after.masters).toHaveLength(21);
    expect(after.masters.find((master) => master.id === old.id)).toMatchObject({
      state: "superseded",
      isCurrent: false,
      revNo: 5,
    });
    expect(after.masters.filter((master) => master.isCurrent)).toHaveLength(20);
    for (const item of batch.items) {
      const master = after.masters.find((one) => one.fileId === item.fileId);
      expect(master).toMatchObject({
        episodeNo: item.episodeNo,
        state: "ready",
        isCurrent: true,
        uploadBatchId: batch.uploadBatchId,
        durationMs: 20_000 + item.episodeNo!,
        replaceReason: "quality_fix",
        isContentChanged: true,
        createdByStaffId: h.actor.identity.actor.id,
        activatedAt: now,
      });
      expect(after.refs.find((ref) => ref.refId === master?.id)).toMatchObject({
        fileId: item.fileId,
        refType: "drama_episode_master",
        role: "main",
        state: "live",
        releasedAt: null,
        keepUntil: null,
      });
      expect(
        after.refs.find((ref) => ref.refId === batch.uploadBatchId && ref.fileId === item.fileId),
      ).toMatchObject({ state: "released", releasedAt: now });
      expect(after.files.find((file) => file.id === item.fileId)?.purgeAfter).toBeNull();
    }
    const oldRef = after.refs.find((ref) => ref.refId === old.id);
    expect(oldRef).toMatchObject({
      state: "released",
      releasedAt: now,
      keepUntil: new Date(now.getTime() + retentionMs),
    });
    expect(after.files.find((file) => file.id === old.fileId)?.purgeAfter).toEqual(
      oldRef?.keepUntil,
    );
    expect(after.events).toHaveLength(1);
    expect(after.events[0]).toMatchObject({
      dedupeKey: batch.uploadBatchId,
      actorType: "staff",
      actorId: h.actor.identity.actor.id,
      client: "admin",
      occurredAt: now,
    });
    expect(after.events[0]?.payload).toEqual({
      v: 1,
      dramaId: h.drama.id,
      uploadBatchId: batch.uploadBatchId,
      episodeNos,
      isContentChanged: true,
    });
    expect(after.audits).toHaveLength(1);
    h.clock.advance(1_000);
    expect(await commit()).toEqual(result);
    expect(await projection(fixture)).toEqual(after);
  });

  it("其他规格的 pass 不能提交原片，全部版本、引用、批次和事件保持不变", async () => {
    const fixture = await readyMasters();
    const { h, batch } = fixture;
    await h.prisma.mediaCheck.update({
      where: { fileId: batch.items[19]!.fileId },
      data: { profile: "asset" },
    });
    const before = await projection(fixture);
    await expect(
      h.media.uploadBatches.commit(
        h.actor,
        batch.uploadBatchId,
        {},
        h.options("commit", {}, undefined, batch.uploadBatchId),
      ),
    ).rejects.toMatchObject({ error: "FILE_NOT_AVAILABLE" });
    expect(await projection(fixture)).toEqual(before);
  });

  it("登记后实际总集数改变必须拒绝提交，不能沿旧20集快照写版本", async () => {
    const fixture = await readyMasters();
    const { h, batch } = fixture;
    await h.make.dramaEpisode({ dramaId: h.drama.id, episodeNo: 21 });
    await h.prisma.drama.update({ where: { id: h.drama.id }, data: { totalEpisodes: 21 } });
    const before = await projection(fixture);
    await expect(
      h.media.uploadBatches.commit(
        h.actor,
        batch.uploadBatchId,
        {},
        h.options("commit", {}, undefined, batch.uploadBatchId),
      ),
    ).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
    expect(await projection(fixture)).toEqual(before);
  });

  it("最后一个公共引用释放失败时整批回滚，同键随后可成功且只发一次真实事件", async () => {
    const fixture = await readyMasters();
    const { h, batch, old } = fixture;
    const before = await projection(fixture);
    const originalRelease = h.media.release;
    const fault = new Error("commit_reference_fault");
    let batchReleases = 0;
    const release = vi.spyOn(h.media, "release").mockImplementation(async (tx, input) => {
      await originalRelease(tx, input);
      if (input.refType !== "upload_batch" || ++batchReleases !== 20) return;
      expect(
        await tx.dramaEpisodeMaster.count({ where: { uploadBatchId: batch.uploadBatchId } }),
      ).toBe(20);
      expect(
        await tx.dramaEpisodeMaster.findUniqueOrThrow({ where: { id: old.id } }),
      ).toMatchObject({ state: "superseded", isCurrent: false });
      expect(
        await tx.fileRef.count({ where: { refId: batch.uploadBatchId, state: "released" } }),
      ).toBe(20);
      throw fault;
    });
    const key = uuidv7();
    const commit = () =>
      h.media.uploadBatches.commit(
        h.actor,
        batch.uploadBatchId,
        {},
        h.options("commit", {}, key, batch.uploadBatchId),
      );
    try {
      await expect(commit()).rejects.toBe(fault);
    } finally {
      release.mockRestore();
    }
    expect(batchReleases).toBe(20);
    expect(await projection(fixture)).toEqual(before);
    const result = await commit();
    expect(result.masters).toHaveLength(20);
    const after = await projection(fixture);
    expect(after.masters).toHaveLength(21);
    expect(after.events).toHaveLength(1);
    expect(after.audits).toHaveLength(1);
  });
});
