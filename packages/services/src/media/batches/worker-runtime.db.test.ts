import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { assertNotInTransaction } from "../../kernel/index.js";
import { failed, ok } from "../../providers/types.js";
import type { ProbeReport } from "../../providers/types.js";
import { useSeededDatabase } from "../../testing/index.js";
import { batchHarness, MP4_HEADER } from "./batch-test.fixture.js";

const db = useSeededDatabase("services", { label: "batchruntime" });
const owned: Awaited<ReturnType<typeof batchHarness>>[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((h) => h.media.jobs.shutdown()));
});
// IO doubles test the real public runner and database settlement, not playable-media validity.
const poster = new Uint8Array([1, 2, 3]);
function report(width: number): ProbeReport {
  const video = {
    index: 0,
    codecType: "video",
    codecName: "h264",
    profile: "High",
    pixFmt: "yuv420p",
    bitsPerRawSample: 8,
    width,
    height: 1280,
    rotation: 0,
    displayWidth: width,
    displayHeight: 1280,
    sampleAspectRatio: "1:1",
    rFrameRate: "30/1",
    avgFrameRate: "30/1",
    nbFrames: 600,
    startTimeMs: 0,
    durationMs: 20000,
    bitRate: 6000000,
    sampleRate: null,
    channels: null,
    attachedPic: false,
  };
  return {
    demuxer: "mov",
    format: {
      formatName: "mov,mp4",
      majorBrand: "isom",
      durationMs: 20000,
      sizeBytes: MP4_HEADER.length,
      bitRate: 6000000,
      tags: {},
    },
    streams: [
      video,
      {
        ...video,
        index: 1,
        codecType: "audio",
        codecName: "aac",
        profile: null,
        pixFmt: null,
        width: null,
        height: null,
        displayWidth: null,
        displayHeight: null,
        sampleRate: 48000,
        channels: 2,
      },
    ],
    boxes: ["ftyp", "moov", "mdat"],
    moovBeforeMdat: true,
    aigc: null,
  };
}
async function setup(width = 720) {
  const h = await batchHarness(await db.prisma(), (fake) => ({
    tool: {
      probe: async () => {
        assertNotInTransaction("batch-probe");
        return ok(report(width));
      },
      poster: async () =>
        ok({ bytes: poster, sizeBytes: poster.length, width: 720, height: 1280, atMs: 1000 }),
      stampAigc: async () => failed("unsupported", "unused"),
      health: async () => ok({ ffmpeg: "fake", ffprobe: "fake" }),
    },
    workspace: {
      close: async () => {},
      run: async (job, signal, action) => {
        assertNotInTransaction("batch-workspace");
        return action({
          path: (name) => `${job.id}/${name}`,
          download: async () =>
            signal.aborted
              ? failed("unavailable", "canceled")
              : ok({
                  size: MP4_HEADER.length,
                  sha256: createHash("sha256").update(MP4_HEADER).digest("hex"),
                }),
          publish: async (request) => {
            assertNotInTransaction("batch-publish");
            return ok({
              size: poster.length,
              sha256: createHash("sha256").update(poster).digest("hex"),
              etag: fake.storage.put(request.dst, poster, "image/jpeg"),
            });
          },
        });
      },
    },
    cloud: fake.media,
    config: {
      aigc: {
        Label: "1",
        ContentProducer: "PUBLIC-TEST",
        ReservedCode1: "",
        ContentPropagator: "",
        ReservedCode2: "",
      },
      templates: {
        normalize: "normalize",
        sd: "sd",
        hd: "hd",
        sample: "sample",
        brand: "brand",
        ai: "ai",
      },
    },
    parameters: async () => ({
      finalMaxMb: 200,
      softDurationMs: 180000,
      ruleVersion: 1,
      specVersion: 1,
    }),
    readStoreFacts: async () => null,
  }));
  owned.push(h);
  const batch = await h.create();
  await h.media.uploadBatches.start(h.actor, batch.uploadBatchId, {});
  const item = batch.items[0]!;
  const file = await h.prisma.fileObject.findUniqueOrThrow({ where: { id: item.fileId } });
  h.fake.storage.put({ bucket: "media", key: file.incomingKey! }, MP4_HEADER, "video/mp4");
  await h.media.uploadBatches.complete(h.actor, item.uploadBatchItemId, {});
  const promote = await h.prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${file.id}` },
  });
  return { ...h, batch, item, file, promote };
}
describe("批次经公开媒体执行器收敛（替身IO）", { timeout: 60000 }, () => {
  it("真实promote建立批次引用并排队probe；真实probe结算master检查后才能ready", async () => {
    const h = await setup();
    await h.media.promote({ jobId: h.promote.id });
    expect((await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: h.promote.id } })).state).toBe(
      "succeeded",
    );
    expect((await h.media.uploadBatches.get(h.actor, h.batch.uploadBatchId)).items[0]!.state).toBe(
      "uploaded",
    );
    expect(
      await h.prisma.fileRef.count({
        where: {
          fileId: h.file.id,
          refType: "upload_batch",
          refId: h.batch.uploadBatchId,
          state: "live",
        },
      }),
    ).toBe(1);
    const probe = await h.prisma.mediaJob.findFirstOrThrow({
      where: { kind: "probe", subjectId: h.file.id },
    });
    expect(probe).toMatchObject({ parentType: "upload_batch", parentId: h.batch.uploadBatchId });
    expect(await h.prisma.mediaCheck.count({ where: { fileId: h.file.id } })).toBe(0);
    await h.media.promote({ jobId: probe.id });
    expect((await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: probe.id } })).state).toBe(
      "succeeded",
    );
    expect(await h.media.uploadBatches.get(h.actor, h.batch.uploadBatchId)).toMatchObject({
      state: "ready",
      counts: { checked: 1 },
    });
    expect(
      await h.prisma.mediaCheck.findUniqueOrThrow({ where: { fileId: h.file.id } }),
    ).toMatchObject({ profile: "master", gate: "pass" });
    expect(await h.prisma.productionRecord.count({ where: { fileId: h.file.id } })).toBe(0);
    await h.media.promote({ jobId: probe.id });
    expect(
      await h.prisma.fileRef.count({ where: { fileId: h.file.id, refType: "upload_batch" } }),
    ).toBe(1);
  });
  it("真实probe规格拒绝不能产生ready", async () => {
    const h = await setup(640);
    await h.media.promote({ jobId: h.promote.id });
    const probe = await h.prisma.mediaJob.findFirstOrThrow({
      where: { kind: "probe", subjectId: h.file.id },
    });
    await h.media.promote({ jobId: probe.id });
    expect(
      await h.prisma.mediaCheck.findUniqueOrThrow({ where: { fileId: h.file.id } }),
    ).toMatchObject({ profile: "master", gate: "reject" });
    expect(await h.media.uploadBatches.get(h.actor, h.batch.uploadBatchId)).toMatchObject({
      state: "verifying",
      counts: { rejected: 1, checked: 0 },
    });
  });
  it("确认后来源变化经真实promote拒收并收敛条目，不能排队probe", async () => {
    const h = await setup();
    h.fake.storage.put(
      { bucket: "media", key: h.file.incomingKey! },
      new Uint8Array([9]),
      "video/mp4",
    );
    await h.media.promote({ jobId: h.promote.id });
    expect((await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: h.promote.id } })).state).toBe(
      "failed",
    );
    expect(await h.media.uploadBatches.get(h.actor, h.batch.uploadBatchId)).toMatchObject({
      counts: { rejected: 1, checked: 0 },
    });
    expect(await h.prisma.fileObject.findUniqueOrThrow({ where: { id: h.file.id } })).toMatchObject(
      { status: "rejected", rejectReason: "changed_after_confirm" },
    );
    expect(await h.prisma.mediaJob.count({ where: { kind: "probe", subjectId: h.file.id } })).toBe(
      0,
    );
    expect(await h.prisma.fileRef.count({ where: { fileId: h.file.id } })).toBe(0);
  });
  it("替换后旧promote结果被取消，当前pending条目和引用不改变", async () => {
    const h = await setup();
    await h.media.uploadBatches.update(h.actor, h.item.uploadBatchItemId, {
      replacementFile: { originalName: "新第1集.mp4", sizeBytes: "8", clientToken: h.file.id },
    });
    const before = await h.media.uploadBatches.get(h.actor, h.batch.uploadBatchId);
    await h.media.promote({ jobId: h.promote.id });
    expect((await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: h.promote.id } })).state).toBe(
      "canceled",
    );
    const after = await h.media.uploadBatches.get(h.actor, h.batch.uploadBatchId);
    expect(after.counts).toEqual(before.counts);
    expect(after.items.find((i) => i.state === "pending")!.fileId).toBe(
      before.items.find((i) => i.state === "pending")!.fileId,
    );
    expect(
      await h.prisma.fileRef.count({
        where: { refType: "upload_batch", refId: h.batch.uploadBatchId },
      }),
    ).toBe(0);
  });
});
