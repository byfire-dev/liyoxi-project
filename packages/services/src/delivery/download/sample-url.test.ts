import { afterAll, beforeAll, expect, it } from "vitest";
import { useSeededDatabase } from "../../testing/index.js";
import { productionHarness as harness } from "../__fixtures__/production-tools.js";
import type { ProductionHarness as Harness } from "../__fixtures__/production-tools.js";
import { createDeliveryDownloads } from "./index.js";
import { meta, sampleReady, snapshot } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
afterAll(async () => {
  await h?.close();
});
it("Q9真实上传/质检/推送仅weapp；两次旧相册请求零签名/零访问记录，确认必须勾选", async () => {
  const { o, sample, a, downloads } = await sampleReady(h);
  expect(sample.previewChannels).toEqual(["weapp"]);
  const before = await snapshot(h),
    calls = h.fake.storage.callsOf("presignGet").length;
  for (let i = 0; i < 2; i++) {
    await expect(downloads.sampleUrl(o.viewer, sample.sampleId, meta)).rejects.toMatchObject({
      error: "FEATURE_DISABLED",
    });
    h.clock.advance(1000);
  }
  expect(await snapshot(h)).toEqual(before);
  expect(h.fake.storage.callsOf("presignGet")).toHaveLength(calls);
  expect(
    (await h.prisma.sample.findUniqueOrThrow({ where: { id: sample.sampleId } })).firstViewedAt,
  ).toBeNull();
  await expect(
    a.sampleConfirm(o.viewer, sample.sampleId, {
      versionNo: 1,
      viewedVia: "weapp",
      hasViewed: false,
    }),
  ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
  expect(await snapshot(h)).toEqual(before);
  expect(
    await a.sampleConfirm(o.viewer, sample.sampleId, {
      versionNo: 1,
      viewedVia: "weapp",
      hasViewed: true,
    }),
  ).toMatchObject({ status: "confirmed", viewedAckAt: h.clock.now().toISOString() });
}, 60000);
it("播放关闭后旧相册入口仍拒绝，没有相册兜底、签名或确认写入", async () => {
  let enabled = true;
  const r = await sampleReady(h, async () => enabled);
  const before = await snapshot(h),
    calls = h.fake.storage.callsOf("presignGet").length;
  enabled = false;
  await expect(r.downloads.sampleUrl(r.o.viewer, r.sample.sampleId, meta)).rejects.toMatchObject({
    error: "FEATURE_DISABLED",
  });
  const view = await r.a.merchantSample(r.o.viewer, r.item.id);
  expect(view).toMatchObject({ previewChannels: ["weapp"], confirmableVia: [], actions: [] });
  expect(view.playable?.sources).toEqual([]);
  await expect(
    r.a.sampleConfirm(r.o.viewer, r.sample.sampleId, {
      versionNo: 1,
      viewedVia: "weapp",
      hasViewed: true,
    }),
  ).rejects.toMatchObject({ error: "FEATURE_DISABLED" });
  expect(await snapshot(h)).toEqual(before);
  // GET may sign the poster only; the disabled legacy operation never signs a video.
  const watermark = await h.prisma.playableAsset.findFirstOrThrow({
    where: { sourceFileId: r.file.id },
  });
  const sourceId = (watermark.renditions as Array<{ fileId: string }>)[0]!.fileId;
  const file = await h.prisma.fileObject.findUniqueOrThrow({ where: { id: sourceId } });
  expect(
    h.fake.storage
      .callsOf("presignGet")
      .slice(calls)
      .some((c) => (c.input as { key: string }).key === file.objectKey),
  ).toBe(false);
}, 60000);
it("旧operation不进入Provider，Provider故障或签后变化没有发生机会且零业务写", async () => {
  const r = await sampleReady(h),
    before = await snapshot(h);
  let signed = 0;
  const service = createDeliveryDownloads({
    ...h.deps,
    media: {
      deliveryProductionFacts: h.media.deliveryProductionFacts,
      signDeliveryDownload: async () => {
        signed++;
        throw new Error("Provider must not be called");
      },
    },
  });
  await expect(service.sampleUrl(r.o.viewer, r.sample.sampleId, meta)).rejects.toMatchObject({
    error: "FEATURE_DISABLED",
  });
  expect(signed).toBe(0);
  expect(await snapshot(h)).toEqual(before);
}, 60000);
it("旧operation保留实时老板/归属/门店归档和版本守卫；确认重新核真实水印就绪", async () => {
  const r = await sampleReady(h),
    before = await snapshot(h);
  await h.prisma.entityMember.update({ where: { id: r.o.member.id }, data: { role: "clerk" } });
  await expect(r.downloads.sampleUrl(r.o.viewer, r.sample.sampleId, meta)).rejects.toMatchObject({
    error: "ROLE_FORBIDDEN",
  });
  await h.prisma.entityMember.update({ where: { id: r.o.member.id }, data: { role: "owner" } });
  await h.prisma.store.update({
    where: { id: r.o.store.id },
    data: {
      lifecycle: "archived",
      archiveReason: "by_owner",
      archivedAt: h.clock.now(),
      archiveActorType: "merchant",
      archiveActorId: r.o.user.id,
      archiveClient: "weapp",
    },
  });
  await expect(r.downloads.sampleUrl(r.o.viewer, r.sample.sampleId, meta)).rejects.toMatchObject({
    error: "STORE_ARCHIVED",
  });
  await h.prisma.store.update({
    where: { id: r.o.store.id },
    data: {
      lifecycle: "active",
      archiveReason: null,
      archivedAt: null,
      archiveActorType: null,
      archiveActorId: null,
      archiveClient: null,
    },
  });
  const p = await h.prisma.playableAsset.findFirstOrThrow({ where: { sourceFileId: r.file.id } });
  const output = (p.renditions as Array<{ fileId: string }>)[0]!.fileId;
  await h.prisma.fileObject.update({ where: { id: output }, data: { moderationState: "block" } });
  await expect(
    r.a.sampleConfirm(r.o.viewer, r.sample.sampleId, {
      versionNo: 1,
      viewedVia: "weapp",
      hasViewed: true,
    }),
  ).rejects.toMatchObject({ error: "SAMPLE_PREVIEW_NOT_READY" });
  await h.prisma.fileObject.update({ where: { id: output }, data: { moderationState: "none" } });
  await h.prisma.playableAsset.update({ where: { id: p.id }, data: { state: "processing" } });
  await expect(
    r.a.sampleConfirm(r.o.viewer, r.sample.sampleId, {
      versionNo: 1,
      viewedVia: "weapp",
      hasViewed: true,
    }),
  ).rejects.toMatchObject({ error: "SAMPLE_PREVIEW_NOT_READY" });
  await h.prisma.playableAsset.update({ where: { id: p.id }, data: { state: "ready" } });
  await h.prisma.sample.update({
    where: { id: r.sample.sampleId },
    data: { status: "superseded" },
  });
  await expect(r.downloads.sampleUrl(r.o.viewer, r.sample.sampleId, meta)).rejects.toMatchObject({
    error: "STATE_NOT_ALLOWED",
  });
  // Restore the deliberately invalidated state before comparing the no-write evidence.
  await h.prisma.sample.update({ where: { id: r.sample.sampleId }, data: { status: "pushed" } });
  expect(await snapshot(h)).toEqual(before);
}, 60000);
