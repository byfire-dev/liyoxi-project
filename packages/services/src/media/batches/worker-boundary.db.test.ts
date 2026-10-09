import { describe, expect, it } from "vitest";
import { useSeededDatabase } from "../../testing/index.js";
import { batchDraft, batchHarness } from "./batch-test.fixture.js";
import { lockBatchFiles, lockBatchRecords } from "./helpers.js";

const db = useSeededDatabase("services", { label: "batchworker" });
const setup = async () => batchHarness(await db.prisma());

describe("批次 worker 的真实归属与结论边界", { timeout: 60_000 }, () => {
  it("替换及跳过后旧文件任务不再属于有效条目，其他批次不能借用文件", async () => {
    const h = await setup();
    const batch = await h.create([batchDraft("第1集.mp4"), batchDraft("第2集.mp4")]);
    const other = await h.create([batchDraft("第3集.mp4")]);
    await h.media.uploadBatches.start(h.actor, batch.uploadBatchId, {});
    const first = batch.items[0]!,
      second = batch.items[1]!;
    const needed = (fileId: string, batchId = batch.uploadBatchId) =>
      h.tx.run((tx) => h.worker.needsJob(tx, { batchId, fileId }));
    expect(await needed(first.fileId)).toBe(true);
    expect(await needed(first.fileId, other.uploadBatchId)).toBe(false);
    await h.media.uploadBatches.update(h.actor, second.uploadBatchItemId, { skip: true });
    const replaced = await h.media.uploadBatches.update(h.actor, first.uploadBatchItemId, {
      replacementFile: batchDraft("新第1集.mp4"),
    });
    const active = replaced.items.find((one) => one.state === "pending")!;
    expect(await needed(first.fileId)).toBe(false);
    expect(await needed(second.fileId)).toBe(false);
    expect(await needed(active.fileId)).toBe(true);
    expect(await h.prisma.mediaJob.count({ where: { parentId: batch.uploadBatchId } })).toBe(0);
  });

  it("未开始、取消或超时的批次不认领任务，读取资格没有业务写入", async () => {
    const h = await setup();
    const batch = await h.create([batchDraft("第1集.mp4")]);
    const query = () =>
      h.tx.run((tx) =>
        h.worker.needsJob(tx, {
          batchId: batch.uploadBatchId,
          fileId: batch.items[0]!.fileId,
        }),
      );
    expect(await query()).toBe(false);
    await h.media.uploadBatches.cancel(h.actor, batch.uploadBatchId, {});
    expect(await query()).toBe(false);
    const expired = await h.create([batchDraft("第2集.mp4")]);
    await h.media.uploadBatches.start(h.actor, expired.uploadBatchId, {});
    h.clock.advance(73 * 60 * 60_000);
    const before = await h.prisma.uploadBatch.findUniqueOrThrow({
      where: { id: expired.uploadBatchId },
    });
    expect(
      await h.tx.run((tx) =>
        h.worker.needsJob(tx, {
          batchId: expired.uploadBatchId,
          fileId: expired.items[0]!.fileId,
        }),
      ),
    ).toBe(false);
    expect(await h.prisma.uploadBatch.findUniqueOrThrow({ where: { id: before.id } })).toEqual(
      before,
    );
  });

  it("只传入 stored/pass 意图不能建立引用或伪造 checked，没有实际入库和检查便回滚", async () => {
    const h = await setup();
    const batch = await h.create([batchDraft("第1集.mp4")]);
    await h.media.uploadBatches.start(h.actor, batch.uploadBatchId, {});
    const item = batch.items[0]!,
      before = await h.prisma.uploadBatchItem.findUniqueOrThrow({
        where: { id: item.uploadBatchItemId },
      });
    for (const apply of [
      (tx: Parameters<typeof h.worker.stored>[0]) => h.worker.stored(tx, item.fileId),
      (tx: Parameters<typeof h.worker.stored>[0]) =>
        h.worker.checked(tx, {
          fileId: item.fileId,
          gate: "pass",
          derivedFromFileId: null,
        }),
    ])
      await expect(
        h.tx.run(async (tx) => {
          await lockBatchRecords(tx, batch.uploadBatchId);
          await lockBatchFiles(tx, batch.uploadBatchId);
          await apply(tx);
        }),
      ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(await h.prisma.uploadBatchItem.findUniqueOrThrow({ where: { id: before.id } })).toEqual(
      before,
    );
    expect(await h.prisma.fileRef.count({ where: { fileId: item.fileId } })).toBe(0);
    expect(await h.prisma.mediaInfo.count({ where: { fileId: item.fileId } })).toBe(0);
    expect(await h.prisma.mediaCheck.count({ where: { fileId: item.fileId } })).toBe(0);
    expect(
      (await h.prisma.uploadBatch.findUniqueOrThrow({ where: { id: batch.uploadBatchId } })).state,
    ).toBe("uploading");
  });
});
