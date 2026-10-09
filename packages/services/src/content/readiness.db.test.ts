import { expect, it } from "vitest";
import { createClock, createFactories, useSeededDatabase } from "../testing/index.js";
import { buildContentTest } from "./test-harness.js";
import { lifecycleWorld } from "./lifecycle.test-world.js";
import { uuidv7 } from "../kernel/index.js";

const db = useSeededDatabase("services");

it("剧集行齐全但没有真实当前原片时，公开上架校验 L10 必须阻断", async () => {
  const clock = createClock();
  const h = await buildContentTest(db, clock);
  try {
    const make = createFactories({ db: h.prisma, clock });
    const drama = await make.drama({ status: "draft", totalEpisodes: 1 });
    await make.dramaEpisode({ dramaId: drama.id, episodeNo: 1 });
    expect(await h.prisma.dramaEpisodeMaster.count({ where: { dramaId: drama.id } })).toBe(0);
    const result = await h.tx.run((tx) => h.content.listingChecks(tx, drama.id));
    expect(result.items.find((item) => item.code === "L10")).toMatchObject({
      isOk: false,
      severity: "block",
    });
    expect(result.isShelvable).toBe(false);
  } finally {
    await h.media.jobs.shutdown();
    h.unbind();
  }
});

it("真实当前原片仍须stored、未block且master体检通过；开放批次仅投影真实处理集号", async () => {
  const h = await lifecycleWorld(db);
  try {
    const { drama } = await h.draft(2),
      { files, batch } = await h.masters(drama.id, [1, 2]);
    const read = () => h.tx.run((tx) => h.content.mediaReadiness(tx, drama.id));
    expect((await read()).mastersReady).toBe(true);
    await h.prisma.fileObject.update({
      where: { id: files[0]!.fileId },
      data: { moderationState: "block" },
    });
    expect((await read()).masters).toMatchObject({ withCurrentMaster: 1, missingEpisodeNos: [1] });
    await h.prisma.fileObject.update({
      where: { id: files[0]!.fileId },
      data: { moderationState: "none" },
    });
    await h.prisma.mediaCheck.update({
      where: { fileId: files[0]!.fileId },
      data: { gate: "reject" },
    });
    expect((await read()).mastersReady).toBe(false);
    await h.prisma.mediaCheck.update({
      where: { fileId: files[0]!.fileId },
      data: { gate: "pass" },
    });
    const pending = await h.prisma.uploadBatch.create({
      data: {
        id: uuidv7(),
        purpose: batch.purpose,
        targetId: batch.targetId,
        variant: batch.variant,
        createdByStaffId: batch.createdByStaffId,
        state: "verifying",
        expectedCount: batch.expectedCount,
        scope: batch.scope,
        replaceReason: batch.replaceReason,
        isContentChanged: batch.isContentChanged,
        note: batch.note,
        expiresAt: batch.expiresAt,
        committedAt: null,
        idempotencyKey: uuidv7(),
        createdAt: batch.createdAt,
        updatedAt: batch.updatedAt,
      },
    });
    const pendingFile = await h.make.fileObject({
      category: "drama_master",
      uploadBatchId: pending.id,
    });
    await h.prisma.uploadBatchItem.create({
      data: {
        id: uuidv7(),
        uploadBatchId: pending.id,
        fileId: pendingFile.id,
        originalName: "第1集.mp4",
        episodeNo: 1,
        state: "uploaded",
        matchMethod: "pattern",
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const processing = await read();
    expect(processing.episodes.map((v) => v.masterState)).toEqual(["processing", "ready"]);
    expect(processing.openUploadBatches.map((v) => v.id)).toEqual([pending.id]);
    expect(processing.mastersReady).toBe(true);
  } finally {
    await h.close();
  }
});

it("缺集清单最多100但101集的实际总数与未就绪不能被截断伪绿", async () => {
  const h = await lifecycleWorld(db);
  try {
    const { drama } = await h.draft(101);
    const read = await h.tx.run((tx) => h.content.mediaReadiness(tx, drama.id));
    expect(read.masters).toMatchObject({ totalEpisodes: 101, withCurrentMaster: 0 });
    expect(read.masters.missingEpisodeNos).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(read.mastersReady).toBe(false);
  } finally {
    await h.close();
  }
});
