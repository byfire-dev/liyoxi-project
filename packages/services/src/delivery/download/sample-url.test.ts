import { afterAll, beforeAll, expect, it } from "vitest";
import { DownloadUrlSchema } from "@liyoxi/contract";
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
it("真实上传/质检/推送后，签发两次各留访问证据，首次时间不覆盖且原a确认可消费", async () => {
  const r = await sampleReady(h),
    { o, sample, a, downloads } = r;
  await expect(
    a.sampleConfirm(o.viewer, sample.sampleId, {
      versionNo: 1,
      viewedVia: "album",
      hasViewed: true,
    }),
  ).rejects.toMatchObject({ error: "SAMPLE_NOT_VIEWABLE" });
  const first = DownloadUrlSchema.parse(await downloads.sampleUrl(o.viewer, sample.sampleId, meta));
  expect(first).toMatchObject({
    fileName: "测试短剧1_样片_第1版.mp4",
    sizeBytes: "1234",
    expiresAt: new Date(h.clock.now().getTime() + 900000).toISOString(),
  });
  const viewed = (await h.prisma.sample.findUniqueOrThrow({ where: { id: sample.sampleId } }))
    .firstViewedAt;
  const before = await snapshot(h);
  h.clock.advance(1000);
  const second = await downloads.sampleUrl(o.viewer, sample.sampleId, meta);
  expect(second.url).not.toBe(first.url);
  expect(
    (await h.prisma.sample.findUniqueOrThrow({ where: { id: sample.sampleId } })).firstViewedAt,
  ).toEqual(viewed);
  const rows = await h.prisma.auditLog.findMany({
    where: { targetId: sample.sampleId, action: "delivery.sample.album_download" },
  });
  expect(rows).toHaveLength(2);
  for (const row of rows)
    expect(row).toMatchObject({
      stream: "access",
      category: "file_access",
      actorType: "merchant",
      actorId: o.user.id,
      client: "weapp",
      targetType: "sample",
      entityId: o.entity.id,
      storeId: o.store.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      authMethod: "weapp",
      meta: { fileCategory: "sample_wm", urlTtlSec: 900 },
    });
  const after = await snapshot(h);
  expect(after.slice(1, 4)).toEqual(before.slice(1, 4));
  expect(
    (
      await a.sampleConfirm(o.viewer, sample.sampleId, {
        versionNo: 1,
        viewedVia: "album",
        hasViewed: true,
      })
    ).status,
  ).toBe("confirmed");
}, 60000);
it("推送快照仅weapp且播放开关仍开拒绝，关闭后相册兜底的证据可确认weapp", async () => {
  let enabled = true;
  const r = await sampleReady(h, async () => enabled);
  expect(r.sample.previewChannels).toEqual(["weapp"]);
  const before = await snapshot(h),
    calls = h.fake.storage.callsOf("presignGet").length;
  await expect(r.downloads.sampleUrl(r.o.viewer, r.sample.sampleId, meta)).rejects.toMatchObject({
    error: "SAMPLE_VIEW_CHANNEL_NOT_OFFERED",
    details: { previewChannels: ["weapp"] },
  });
  expect(await snapshot(h)).toEqual(before);
  expect(h.fake.storage.callsOf("presignGet")).toHaveLength(calls);
  enabled = false;
  await r.downloads.sampleUrl(r.o.viewer, r.sample.sampleId, meta);
  expect(
    (
      await r.a.sampleConfirm(r.o.viewer, r.sample.sampleId, {
        versionNo: 1,
        viewedVia: "weapp",
        hasViewed: true,
      })
    ).status,
  ).toBe("confirmed");
}, 60000);
it("Provider失败和证据事务失败均零业务写，签名在业务事务外", async () => {
  const r = await sampleReady(h),
    before = await snapshot(h);
  h.fake.storage.failNext("presignGet");
  await expect(r.downloads.sampleUrl(r.o.viewer, r.sample.sampleId, meta)).rejects.toThrow();
  expect(await snapshot(h)).toEqual(before);
  let calls = 0,
    active = false;
  const service = createDeliveryDownloads({
    ...h.deps,
    tx: {
      run: (fn, options) => {
        const n = ++calls;
        return h.tx.run(async (tx) => {
          active = true;
          try {
            const value = await fn(tx);
            if (n === 2) throw new Error("证据收尾故障");
            return value;
          } finally {
            active = false;
          }
        }, options);
      },
    },
    media: {
      ...h.media,
      signDeliveryDownload: async (input) => {
        expect(active).toBe(false);
        return h.media.signDeliveryDownload(input);
      },
    },
  });
  await expect(service.sampleUrl(r.o.viewer, r.sample.sampleId, meta)).rejects.toThrow(
    "证据收尾故障",
  );
  expect(await snapshot(h)).toEqual(before);
}, 60000);
it("签后文件失效/撤销老板角色与门店归档均拒绝，旧版或playable未ready不签", async () => {
  const r = await sampleReady(h),
    before = await snapshot(h);
  const invalidated = createDeliveryDownloads({
    ...h.deps,
    media: {
      ...h.media,
      signDeliveryDownload: async (input) => {
        const signed = await h.media.signDeliveryDownload(input);
        await h.prisma.fileObject.update({
          where: { id: input.fileId },
          data: { moderationState: "block" },
        });
        return signed;
      },
    },
  });
  await expect(invalidated.sampleUrl(r.o.viewer, r.sample.sampleId, meta)).rejects.toMatchObject({
    error: "SAMPLE_PREVIEW_NOT_READY",
  });
  expect(await snapshot(h)).toEqual(before);
  await h.prisma.fileObject.update({ where: { id: r.file.id }, data: { moderationState: "none" } });
  const revoked = createDeliveryDownloads({
    ...h.deps,
    media: {
      ...h.media,
      signDeliveryDownload: async (input) => {
        const signed = await h.media.signDeliveryDownload(input);
        await h.prisma.entityMember.update({
          where: { id: r.o.member.id },
          data: { role: "clerk" },
        });
        return signed;
      },
    },
  });
  await expect(revoked.sampleUrl(r.o.viewer, r.sample.sampleId, meta)).rejects.toMatchObject({
    error: "ROLE_FORBIDDEN",
  });
  expect(await snapshot(h)).toEqual(before);
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
  await h.prisma.playableAsset.update({ where: { id: p.id }, data: { state: "processing" } });
  await expect(r.downloads.sampleUrl(r.o.viewer, r.sample.sampleId, meta)).rejects.toMatchObject({
    error: "SAMPLE_PREVIEW_NOT_READY",
  });
  await h.prisma.playableAsset.update({ where: { id: p.id }, data: { state: "ready" } });
  await h.prisma.sample.update({
    where: { id: r.sample.sampleId },
    data: { status: "superseded" },
  });
  await expect(r.downloads.sampleUrl(r.o.viewer, r.sample.sampleId, meta)).rejects.toMatchObject({
    error: "STATE_NOT_ALLOWED",
  });
}, 60000);
