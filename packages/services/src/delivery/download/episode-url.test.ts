import { afterAll, beforeAll, expect, it } from "vitest";
import { EpisodeDownloadUrlSchema } from "@liyoxi/contract";
import { endOfDay } from "@liyoxi/shared/time";
import { assembleForTest, useSeededDatabase } from "../../testing/index.js";
import { defineRegistration, implement, trackPort } from "../../kernel/index.js";
import type { TrackEvent } from "../../kernel/index.js";
import { harness } from "../__fixtures__/harness.js";
import type { Harness } from "../__fixtures__/harness.js";
import { createDeliveryDownloads } from "./index.js";
import { meta, packageReady, snapshot } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
afterAll(() => h?.unbind());
it("三次签发三条独立下载行、样片首集900秒、同日去重键一致/次日不同，零状态事件", async () => {
  const r = await packageReady(h),
    tracks: TrackEvent[] = [];
  const assembly = assembleForTest({
    entry: "api",
    extra: [
      defineRegistration("lyxtest_download", {
        portImplementations: [
          implement(trackPort, {
            record: async (tx, event) => {
              expect(tx).not.toBeNull();
              tracks.push(event);
            },
          }),
        ],
      }),
    ],
  });
  const service = createDeliveryDownloads({ ...h.deps, assembly }),
    before = await snapshot(h);
  const first = EpisodeDownloadUrlSchema.parse(
    await service.episodeUrl(r.o.viewer, r.item.id, { kind: "episode", episodeNo: 1 }, meta),
  );
  h.clock.advance(1000);
  const second = await service.episodeUrl(
      r.o.viewer,
      r.item.id,
      { kind: "episode", episodeNo: 2 },
      meta,
    ),
    third = await service.episodeUrl(
      r.o.viewer,
      r.item.id,
      { kind: "episode", episodeNo: 1 },
      meta,
    );
  expect(new Set([first.downloadId, second.downloadId, third.downloadId]).size).toBe(3);
  expect(first.fileName).toBe("测试短剧1_第01集.mp4");
  expect(first.expiresAt).toBe(new Date(h.clock.now().getTime() + 899000).toISOString());
  const logs = await h.prisma.deliveryDownloadLog.findMany({
    where: { deliveryReleaseId: r.release.id },
    orderBy: { seq: "asc" },
  });
  expect(logs).toHaveLength(3);
  for (const row of logs)
    expect(row).toMatchObject({
      actorType: "merchant",
      actorId: r.o.user.id,
      client: "weapp",
      kind: "episode",
      downloadGrantId: r.grant.id,
      orderItemId: r.item.id,
      urlTtlSec: 900,
      clientAck: null,
      clientAckAt: null,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  expect(logs.map((l) => [l.episodeNo, l.fileId])).toEqual([
    [1, r.file.id],
    [2, r.episodeFile.id],
    [1, r.file.id],
  ]);
  expect(
    h.fake.storage
      .callsOf("presignGet")
      .slice(-3)
      .map((c) => c.input),
  ).toMatchObject([
    { expiresSec: 900, downloadName: first.fileName },
    { expiresSec: 900, downloadName: second.fileName },
    { expiresSec: 900, downloadName: third.fileName },
  ]);
  expect(new Set(tracks.map((e) => e.eventId)).size).toBe(1);
  expect(tracks[0]).toMatchObject({
    name: "package_download",
    eventId: `srv-pkgdl-${r.release.id}-${r.o.user.id}-episode-2026-01-05`,
    subject: { userId: r.o.user.id, entityId: r.o.entity.id, storeId: r.o.store.id },
    props: { orderId: r.o.order.id, method: "episode", channel: "weapp" },
  });
  expect((await snapshot(h)).slice(0, 3)).toEqual(before.slice(0, 3));
  h.clock.advance(24 * 3600000);
  await service.episodeUrl(r.o.viewer, r.item.id, { kind: "episode", episodeNo: 1 }, meta);
  expect(new Set(tracks.map((e) => e.eventId)).size).toBe(2);
}, 60000);
it("授权相等即过期，使用期次日北京时间零点拒绝；归档和套餐过期仍能下", async () => {
  const r = await packageReady(h),
    downloads = r.downloads,
    b = { kind: "episode" as const, episodeNo: 1 };
  const now = h.clock.now();
  h.clock.set(r.grant.expiresAt);
  await expect(downloads.episodeUrl(r.o.viewer, r.item.id, b, meta)).rejects.toMatchObject({
    error: "DOWNLOAD_GRANT_INVALID",
    details: { reason: "expired" },
  });
  const item = await h.prisma.orderItem.findUniqueOrThrow({ where: { id: r.item.id } }),
    boundary = endOfDay(item.usageEndDate.toISOString().slice(0, 10));
  await h.prisma.downloadGrant.update({
    where: { id: r.grant.id },
    data: { expiresAt: new Date(boundary.getTime() + 86400000) },
  });
  h.clock.set(new Date(boundary.getTime() - 1));
  await downloads.episodeUrl(r.o.viewer, r.item.id, b, meta);
  h.clock.set(boundary);
  await expect(downloads.episodeUrl(r.o.viewer, r.item.id, b, meta)).rejects.toMatchObject({
    error: "DOWNLOAD_NOT_AVAILABLE",
    details: { reason: "usage_ended" },
  });
  const term = await h.prisma.subscriptionTerm.findUniqueOrThrow({
    where: { id: r.o.order.subscriptionTermId },
  });
  h.clock.set(new Date(term.endsAt.getTime() + 1));
  expect(term.endsAt < h.clock.now()).toBe(true);
  await h.prisma.store.update({
    where: { id: r.o.store.id },
    data: {
      lifecycle: "archived",
      archiveReason: "by_owner",
      archivedAt: now,
      archiveActorType: "merchant",
      archiveActorId: r.o.user.id,
      archiveClient: "weapp",
    },
  });
  expect(await downloads.episodeUrl(r.o.viewer, r.item.id, b, meta)).toMatchObject({
    sizeBytes: "1234",
  });
  h.clock.set(now);
}, 60000);
it("关闭项、撤销/被替换授权、文件失效与非法集号拒绝且零签零写", async () => {
  const r = await packageReady(h),
    b = { kind: "episode" as const, episodeNo: 1 },
    before = await snapshot(h),
    calls = h.fake.storage.callsOf("presignGet").length;
  for (const episodeNo of [0, 3])
    await expect(
      r.downloads.episodeUrl(r.o.viewer, r.item.id, { ...b, episodeNo }, meta),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
  await expect(
    r.downloads.episodeUrl(r.o.viewer, r.item.id, { kind: "zip", episodeNo: 1 } as never, meta),
  ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
  await h.prisma.downloadGrant.update({
    where: { id: r.grant.id },
    data: { state: "revoked", endedAt: h.clock.now(), revokeReason: "虚构撤销" },
  });
  await expect(r.downloads.episodeUrl(r.o.viewer, r.item.id, b, meta)).rejects.toMatchObject({
    error: "DOWNLOAD_GRANT_INVALID",
    details: { reason: "revoked" },
  });
  await h.prisma.downloadGrant.update({
    where: { id: r.grant.id },
    data: { state: "superseded", revokeReason: null },
  });
  await expect(r.downloads.episodeUrl(r.o.viewer, r.item.id, b, meta)).rejects.toMatchObject({
    error: "DOWNLOAD_GRANT_INVALID",
    details: { reason: "superseded" },
  });
  await h.prisma.downloadGrant.update({
    where: { id: r.grant.id },
    data: { state: "active", endedAt: null },
  });
  await h.prisma.fileObject.update({
    where: { id: r.file.id },
    data: { moderationState: "block" },
  });
  await expect(r.downloads.episodeUrl(r.o.viewer, r.item.id, b, meta)).rejects.toMatchObject({
    error: "DOWNLOAD_NOT_AVAILABLE",
    details: { reason: "file_unavailable" },
  });
  await h.prisma.fileObject.update({ where: { id: r.file.id }, data: { moderationState: "none" } });
  await h.prisma.orderItem.update({
    where: { id: r.item.id },
    data: {
      phase: "cancelled",
      capturedAt: null,
      cancelledAt: h.clock.now(),
      cancelReasonCode: "merchant_request",
    },
  });
  await expect(r.downloads.episodeUrl(r.o.viewer, r.item.id, b, meta)).rejects.toMatchObject({
    error: "DOWNLOAD_NOT_AVAILABLE",
    details: { reason: "order_item_closed" },
  });
  expect(h.fake.storage.callsOf("presignGet")).toHaveLength(calls);
  expect(await snapshot(h)).toEqual(before);
}, 60000);
it("签后授权撤销或文件失效/事务收尾失败，零日志且地址不返回", async () => {
  const r = await packageReady(h),
    b = { kind: "episode" as const, episodeNo: 1 },
    before = await snapshot(h);
  const fail = createDeliveryDownloads({
    ...h.deps,
    media: {
      signDeliveryDownload: async () => {
        throw new Error("虚构签名器故障");
      },
    },
  });
  await expect(fail.episodeUrl(r.o.viewer, r.item.id, b, meta)).rejects.toThrow("虚构签名器故障");
  expect(await snapshot(h)).toEqual(before);
  const changed = createDeliveryDownloads({
    ...h.deps,
    media: {
      signDeliveryDownload: async (input) => {
        const signed = await h.media.signDeliveryDownload(input);
        await h.prisma.downloadGrant.update({
          where: { id: r.grant.id },
          data: { state: "revoked", endedAt: h.clock.now(), revokeReason: "虚构竞态撤销" },
        });
        return signed;
      },
    },
  });
  await expect(changed.episodeUrl(r.o.viewer, r.item.id, b, meta)).rejects.toMatchObject({
    error: "DOWNLOAD_GRANT_INVALID",
  });
  expect(await snapshot(h)).toEqual(before);
  await h.prisma.downloadGrant.update({
    where: { id: r.grant.id },
    data: { state: "active", endedAt: null, revokeReason: null },
  });
  const blockedFile = createDeliveryDownloads({
    ...h.deps,
    media: {
      signDeliveryDownload: async (input) => {
        const signed = await h.media.signDeliveryDownload(input);
        await h.prisma.fileObject.update({
          where: { id: r.file.id },
          data: { moderationState: "block" },
        });
        return signed;
      },
    },
  });
  await expect(blockedFile.episodeUrl(r.o.viewer, r.item.id, b, meta)).rejects.toMatchObject({
    error: "DOWNLOAD_NOT_AVAILABLE",
    details: { reason: "file_unavailable" },
  });
  expect(await snapshot(h)).toEqual(before);
  await h.prisma.fileObject.update({ where: { id: r.file.id }, data: { moderationState: "none" } });
  let calls = 0;
  const rollback = createDeliveryDownloads({
    ...h.deps,
    tx: {
      run: (fn, options) => {
        const n = ++calls;
        return h.tx.run(async (tx) => {
          const value = await fn(tx);
          if (n === 2) throw new Error("下载收尾故障");
          return value;
        }, options);
      },
    },
  });
  await expect(rollback.episodeUrl(r.o.viewer, r.item.id, b, meta)).rejects.toThrow("下载收尾故障");
  expect(await snapshot(h)).toEqual(before);
}, 60000);
