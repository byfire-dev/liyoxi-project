import { describe, expect, it } from "vitest";
import { useSeededDatabase } from "../../testing/index.js";
import { batchDraft, batchHarness } from "./batch-test.fixture.js";
const db = useSeededDatabase("services", { label: "batchrace" });
describe("W3-02 批次原锁序下并发", { timeout: 60_000 }, () => {
  it("两条同时占同集号只有一条成功且仍恰有两个有效条目", async () => {
    const h = await batchHarness(await db.prisma());
    const batch = await h.create([batchDraft("第1集.mp4"), batchDraft("第2集.mp4")]);
    const outcomes = await Promise.allSettled(
      batch.items.map((i) =>
        h.media.uploadBatches.update(h.actor, i.uploadBatchItemId, { episodeNo: 3 }),
      ),
    );
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejection = outcomes.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ error: "BATCH_EPISODE_TAKEN" });
    const items = await h.prisma.uploadBatchItem.findMany({
      where: { uploadBatchId: batch.uploadBatchId },
    });
    expect(items.filter((i) => i.episodeNo === 3)).toHaveLength(1);
    expect(items).toHaveLength(2);
  });
  it("同条目并发替换只有一新文件，旧行replaced且旧pending过期", async () => {
    const h = await batchHarness(await db.prisma()),
      batch = await h.create(),
      item = batch.items[0]!;
    const outcomes = await Promise.allSettled(
      ["新A第1集.mp4", "新B第1集.mp4"].map((name) =>
        h.media.uploadBatches.update(h.actor, item.uploadBatchItemId, {
          replacementFile: batchDraft(name),
        }),
      ),
    );
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejection = outcomes.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(
      await h.prisma.uploadBatchItem.count({
        where: { uploadBatchId: batch.uploadBatchId, state: "pending" },
      }),
    ).toBe(1);
    expect(
      await h.prisma.fileObject.count({
        where: { uploadBatchId: batch.uploadBatchId, status: "pending" },
      }),
    ).toBe(1);
    expect(
      (await h.prisma.fileObject.findUniqueOrThrow({ where: { id: item.fileId } })).status,
    ).toBe("expired");
  });
});
