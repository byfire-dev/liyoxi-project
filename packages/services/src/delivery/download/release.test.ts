import { afterAll, beforeAll, expect, it } from "vitest";
import { DeliveryReleaseDetailSchema, ReleaseViewSchema } from "@liyoxi/contract";
import { ownTaskScope, SYSTEM_SCOPE } from "../../authz/index.js";
import { findI2Violations, findI14Violations } from "../../media/index.js";
import { uuidv7 } from "../../kernel/index.js";
import { useSeededDatabase } from "../../testing/index.js";
import { harness } from "../__fixtures__/harness.js";
import type { Harness } from "../__fixtures__/harness.js";
import { findDeliveryViolations } from "../invariants.js";
import { packageReady, sampleReady, snapshot, meta } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
afterAll(() => h?.unbind());
it("两GET零写，真实清单/授权/空保存进度、后台任务范围和最新关闭包", async () => {
  const r = await packageReady(h),
    before = await snapshot(h);
  const view = ReleaseViewSchema.parse(await r.downloads.release(r.o.viewer, r.item.id)),
    detail = DeliveryReleaseDetailSchema.parse(
      await r.downloads.adminRelease(SYSTEM_SCOPE, r.release.id),
    );
  expect(view).toMatchObject({
    deliveryReleaseId: r.release.id,
    episodeCount: 2,
    totalBytes: "2468",
    isDownloadable: true,
    savedEpisodeCount: 0,
    regrantRemainingToday: 5,
    canRegenerate: true,
    grant: { downloadGrantId: r.grant.id, isExpired: false },
  });
  expect(view.episodes.map((e) => [e.episodeNo, e.fileName, e.lastSavedAt])).toEqual([
    [1, "测试短剧1_第01集.mp4", null],
    [2, "测试短剧1_第02集.mp4", null],
  ]);
  expect(detail).toMatchObject({
    manifest: r.release.manifestSnapshot,
    activeGrant: { downloadGrantId: r.grant.id },
    actions: [],
    ticket: { deliveryTicketId: r.id },
    orderItem: { orderItemId: r.item.id },
    store: { storeId: r.o.store.id },
  });
  expect(detail).not.toHaveProperty("zipState");
  const other = await h.staff("publisher");
  await expect(
    r.downloads.adminRelease(ownTaskScope(other.staff.staff), r.release.id),
  ).rejects.toMatchObject({ error: "NOT_FOUND" });
  expect(await snapshot(h)).toEqual(before);
  await r.downloads.episodeUrl(r.o.viewer, r.item.id, { kind: "episode", episodeNo: 1 }, meta);
  expect(await r.downloads.release(r.o.viewer, r.item.id)).toMatchObject({ savedEpisodeCount: 0 });
  await h.prisma.downloadGrant.update({
    where: { id: r.grant.id },
    data: { state: "revoked", endedAt: h.clock.now(), revokeReason: "虚构关闭包" },
  });
  await h.prisma.deliveryRelease.update({
    where: { id: r.release.id },
    data: { state: "closed", closedAt: h.clock.now(), closeReason: "cancelled" },
  });
  expect(await r.downloads.release(r.o.viewer, r.item.id)).toMatchObject({
    deliveryReleaseId: r.release.id,
    state: "closed",
    isDownloadable: false,
    canRegenerate: false,
  });
  expect(await r.downloads.adminRelease(SYSTEM_SCOPE, r.release.id)).toMatchObject({
    activeGrant: null,
  });
  const closed = await snapshot(h);
  await expect(
    r.downloads.episodeUrl(r.o.viewer, r.item.id, { kind: "episode", episodeNo: 1 }, meta),
  ).rejects.toMatchObject({
    error: "DOWNLOAD_NOT_AVAILABLE",
    details: { reason: "release_closed" },
  });
  expect(await snapshot(h)).toEqual(closed);
}, 60000);
it("从未推送404，跨店对象404，店员仍403", async () => {
  const r = await sampleReady(h);
  await expect(r.downloads.release(r.o.viewer, r.item.id)).rejects.toMatchObject({
    error: "NOT_FOUND",
  });
  const before = await snapshot(h),
    calls = h.fake.storage.callsOf("presignGet").length;
  await expect(
    r.downloads.episodeUrl(r.o.viewer, r.item.id, { kind: "episode", episodeNo: 1 }, meta),
  ).rejects.toMatchObject({
    error: "DOWNLOAD_NOT_AVAILABLE",
    details: { reason: "not_delivered" },
  });
  expect(await snapshot(h)).toEqual(before);
  expect(h.fake.storage.callsOf("presignGet")).toHaveLength(calls);
  const other = await h.order(true);
  await expect(r.downloads.release(other.viewer, r.item.id)).rejects.toMatchObject({
    error: "NOT_FOUND",
  });
  await expect(r.downloads.sampleUrl(other.viewer, r.sample.sampleId, meta)).rejects.toMatchObject({
    error: "NOT_FOUND",
  });
  await expect(
    r.downloads.release(
      { ...r.o.viewer, membership: { ...r.o.viewer.membership, role: "clerk" } },
      r.item.id,
    ),
  ).rejects.toMatchObject({ error: "ROLE_FORBIDDEN" });
}, 60000);
it("交付full全部13检查加media两检查零违规，真实污染log被I4抓到/关闭包activegrant被I15抓到", async () => {
  const r = await packageReady(h);
  await Promise.all(
    [1, 2, 1].map((episodeNo) =>
      r.downloads.episodeUrl(r.o.viewer, r.item.id, { kind: "episode", episodeNo }, meta),
    ),
  );
  const full = h.assembly.invariants.filter(
    (c) => c.code.startsWith("delivery.") && c.modes?.includes("full"),
  );
  expect(full).toHaveLength(13);
  for (const c of full)
    expect(await h.tx.run((tx) => c.run!(tx, {}, { now: h.clock.now() })), c.code).toEqual([]);
  expect(await h.tx.run(findI2Violations)).toEqual([]);
  expect(await h.tx.run((tx) => findI14Violations(tx))).toEqual([]);
  const foreignStore = await h.make.store({ entityId: r.o.entity.id });
  await expect(
    h.tx.run(async (tx) => {
      const id = uuidv7();
      await tx.deliveryDownloadLog.create({
        data: {
          id,
          entityId: r.o.entity.id,
          storeId: foreignStore.id,
          deliveryReleaseId: r.release.id,
          downloadGrantId: r.grant.id,
          orderItemId: r.item.id,
          kind: "episode",
          episodeNo: 1,
          fileId: r.file.id,
          actorType: "merchant",
          actorId: r.o.user.id,
          client: "weapp",
          urlTtlSec: 900,
          createdAt: h.clock.now(),
        },
      });
      expect(await findDeliveryViolations(tx, "I4")).toContainEqual(
        expect.objectContaining({ subject: { type: "delivery_download_log", id } }),
      );
      throw new Error("rollback污染日志");
    }),
  ).rejects.toThrow("rollback污染日志");
  await expect(
    h.tx.run(async (tx) => {
      await tx.deliveryRelease.update({
        where: { id: r.release.id },
        data: { state: "closed", closedAt: h.clock.now(), closeReason: "cancelled" },
      });
      expect(await findDeliveryViolations(tx, "I15")).toContainEqual(
        expect.objectContaining({ subject: { type: "download_grant", id: r.grant.id } }),
      );
      throw new Error("rollback污染授权");
    }),
  ).rejects.toThrow("rollback污染授权");
}, 60000);
