import { describe, expect, it } from "vitest";
import { uuidv7 } from "../../kernel/index.js";
import { useSeededDatabase } from "../../testing/index.js";
import { batchDraft, batchHarness, MP4_HEADER } from "./batch-test.fixture.js";

const db = useSeededDatabase("services", { label: "batchlife" });
const setup = async () => batchHarness(await db.prisma());
describe("W3-02 批次真实数据库生命周期", { timeout: 60_000 }, () => {
  it("完整20集保留登记总数；开始上传不伪造体检或就绪", async () => {
    const h = await setup();
    const batch = await h.create(
      Array.from({ length: 20 }, (_, i) => batchDraft(`第${i + 1}集.mp4`)),
      "full",
    );
    expect(batch).toMatchObject({
      expectedCount: 20,
      counts: { total: 20, pending: 20 },
      state: "matching",
    });
    expect(batch.coverage).toMatchObject({
      missingEpisodeNos: [],
      duplicateEpisodeNos: [],
      unmatchedItemIds: [],
    });
    const started = await h.media.uploadBatches.start(
      h.actor,
      batch.uploadBatchId,
      {},
      h.options("start", {}, undefined, batch.uploadBatchId),
    );
    expect(started.state).toBe("uploading");
    expect(
      await h.prisma.mediaCheck.count({
        where: { fileId: { in: batch.items.map((i) => i.fileId) } },
      }),
    ).toBe(0);
    expect(
      await h.prisma.fileObject.count({
        where: { uploadBatchId: batch.uploadBatchId, status: "pending" },
      }),
    ).toBe(20);
    await expect(
      h.media.uploadBatches.commit(h.actor, batch.uploadBatchId, {}),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
  });
  it("同自然键并行重放只有一批；标准幂等记录清理后仍返回原批", async () => {
    const h = await setup(),
      key = uuidv7(),
      files = [batchDraft("第1集.mp4")];
    const [a, b] = await Promise.all([
      h.create(files, "partial", key),
      h.create(files, "partial", key),
    ]);
    expect(a.uploadBatchId).toBe(b.uploadBatchId);
    await h.prisma.idempotencyRecord.deleteMany({
      where: { key, scope: "admin.uploadBatch.create" },
    });
    h.clock.advance(25 * 60 * 60_000);
    expect((await h.create(files, "partial", key)).uploadBatchId).toBe(a.uploadBatchId);
    expect(
      await h.prisma.uploadBatch.count({
        where: { createdByStaffId: h.actor.staff!.staff.id, idempotencyKey: key },
      }),
    ).toBe(1);
    expect(
      await h.prisma.uploadBatchItem.count({ where: { uploadBatchId: a.uploadBatchId } }),
    ).toBe(1);
  });
  it("full缺集和未接受的顺序建议不得开始，接受真实20条顺序后才开始", async () => {
    const h = await setup();
    const incomplete = await h.create([batchDraft("第1集.mp4")], "full");
    expect(incomplete.coverage.missingEpisodeNos).toHaveLength(19);
    await expect(
      h.media.uploadBatches.start(h.actor, incomplete.uploadBatchId, {}),
    ).rejects.toMatchObject({ error: "BATCH_MATCH_INCOMPLETE" });
    const sequence = await h.create(
      Array.from({ length: 20 }, (_, i) => batchDraft(`素材${String.fromCharCode(65 + i)}.mp4`)),
      "full",
    );
    expect(sequence.coverage.needsSequenceConfirm).toBe(true);
    await expect(
      h.media.uploadBatches.start(h.actor, sequence.uploadBatchId, {}),
    ).rejects.toMatchObject({ error: "BATCH_MATCH_INCOMPLETE" });
    expect(
      (
        await h.media.uploadBatches.start(h.actor, sequence.uploadBatchId, {
          acceptSequenceSuggestion: true,
        })
      ).state,
    ).toBe("uploading");
  });
  it("部分跳过不能删掉最后有效条目，替换保留旧历史并让出pending token", async () => {
    const h = await setup(),
      token = uuidv7();
    const batch = await h.create([batchDraft("第1集.mp4", token), batchDraft("第2集.mp4")]);
    const first = batch.items[0]!,
      second = batch.items[1]!;
    await h.media.uploadBatches.update(h.actor, second.uploadBatchItemId, { skip: true });
    await expect(
      h.media.uploadBatches.update(h.actor, first.uploadBatchItemId, { skip: true }),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    const replaced = await h.media.uploadBatches.update(h.actor, first.uploadBatchItemId, {
      replacementFile: batchDraft("重传第1集.mp4", token),
    });
    expect(replaced.counts).toMatchObject({ total: 3, pending: 1, skipped: 1, replaced: 1 });
    expect(
      (await h.prisma.fileObject.findUniqueOrThrow({ where: { id: first.fileId } })).status,
    ).toBe("expired");
    const active = replaced.items.find((i) => i.state === "pending")!;
    expect(active.fileId).not.toBe(first.fileId);
    expect(active.episodeNo).toBe(1);
  });
  it("无效清单及替换撞其他条目的名称或token时整笔零业务新增", async () => {
    const h = await setup(),
      a = batchDraft("第1集.mp4"),
      b = batchDraft("第2集.mp4");
    const before = await h.prisma.uploadBatch.count();
    await expect(h.create([batchDraft("素材.zip")])).rejects.toMatchObject({
      error: "BATCH_FILE_INVALID",
    });
    expect(await h.prisma.uploadBatch.count()).toBe(before);
    const batch = await h.create([a, b]),
      item = batch.items[0]!;
    for (const replacement of [
      batchDraft(b.originalName),
      batchDraft("另一个第1集.mp4", b.clientToken),
    ]) {
      await expect(
        h.media.uploadBatches.update(h.actor, item.uploadBatchItemId, {
          replacementFile: replacement,
        }),
      ).rejects.toMatchObject({ error: "BATCH_FILE_INVALID" });
      expect(
        await h.prisma.uploadBatchItem.count({ where: { uploadBatchId: batch.uploadBatchId } }),
      ).toBe(2);
      expect(
        (await h.prisma.fileObject.findUniqueOrThrow({ where: { id: item.fileId } })).status,
      ).toBe("pending");
    }
  });
  it("活动顺延同步pending文件；超过原72小时仍可确认且不越创建7天", async () => {
    const h = await setup(),
      batch = await h.create([batchDraft("第1集.mp4"), batchDraft("第2集.mp4")]);
    h.clock.advance(71 * 60 * 60_000);
    const started = await h.media.uploadBatches.start(h.actor, batch.uploadBatchId, {});
    expect(
      (
        await h.prisma.fileObject.findUniqueOrThrow({ where: { id: batch.items[1]!.fileId } })
      ).uploadExpiresAt?.toISOString(),
    ).toBe(started.expiresAt);
    h.clock.advance(2 * 60 * 60_000);
    const file = await h.prisma.fileObject.findUniqueOrThrow({
      where: { id: batch.items[0]!.fileId },
    });
    h.fake.storage.put({ bucket: "media", key: file.incomingKey! }, MP4_HEADER, "video/mp4");
    expect(
      (await h.media.uploadBatches.complete(h.actor, batch.items[0]!.uploadBatchItemId, {}))
        .fileStatus,
    ).toBe("promoting");
    h.clock.advance(60 * 60 * 60_000);
    const capped = await h.media.uploadBatches.update(h.actor, batch.items[1]!.uploadBatchItemId, {
      episodeNo: 3,
    });
    expect(new Date(capped.expiresAt).getTime() - new Date(capped.createdAt).getTime()).toBe(
      7 * 24 * 60 * 60_000,
    );
  });
  it("坏魔数拒收事实持久化；没有promote任务或成功体检", async () => {
    const h = await setup(),
      batch = await h.create();
    await h.media.uploadBatches.start(h.actor, batch.uploadBatchId, {});
    const item = batch.items[0]!,
      file = await h.prisma.fileObject.findUniqueOrThrow({ where: { id: item.fileId } });
    h.fake.storage.put({ bucket: "media", key: file.incomingKey! }, new Uint8Array(8), "video/mp4");
    await expect(
      h.media.uploadBatches.complete(h.actor, item.uploadBatchItemId, {}),
    ).rejects.toMatchObject({ error: "UPLOAD_REJECTED", details: { rejectReason: "bad_magic" } });
    expect(await h.prisma.fileObject.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({
      status: "rejected",
      confirmingUntil: null,
      rejectReason: "bad_magic",
    });
    expect(
      (await h.prisma.uploadBatchItem.findUniqueOrThrow({ where: { id: item.uploadBatchItemId } }))
        .state,
    ).toBe("rejected");
    expect(await h.prisma.mediaJob.count({ where: { subjectId: file.id } })).toBe(0);
    expect(await h.prisma.mediaCheck.count({ where: { fileId: file.id } })).toBe(0);
  });
  it("取消仅matching/ready合法，已开始不能取消；过期写操作零改变", async () => {
    const h = await setup(),
      batch = await h.create();
    expect((await h.media.uploadBatches.cancel(h.actor, batch.uploadBatchId, {})).state).toBe(
      "canceled",
    );
    expect(
      (await h.prisma.fileObject.findUniqueOrThrow({ where: { id: batch.items[0]!.fileId } }))
        .status,
    ).toBe("expired");
    const active = await h.create();
    await h.media.uploadBatches.start(h.actor, active.uploadBatchId, {});
    await expect(
      h.media.uploadBatches.cancel(h.actor, active.uploadBatchId, {}),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    h.clock.advance(73 * 60 * 60_000);
    await expect(
      h.media.uploadBatches.update(h.actor, active.items[0]!.uploadBatchItemId, { episodeNo: 2 }),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(
      (
        await h.prisma.uploadBatchItem.findUniqueOrThrow({
          where: { id: active.items[0]!.uploadBatchItemId },
        })
      ).episodeNo,
    ).toBe(1);
  });
});
