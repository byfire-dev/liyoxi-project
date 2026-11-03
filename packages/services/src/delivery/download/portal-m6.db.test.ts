import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  createPortalDownloadFixture,
  useSeededDatabase,
  snapshotTables,
  assertSnapshotsEqual,
} from "../../testing/index.js";
import { createIdempotencyContext, uuidv7 } from "../../kernel/index.js";
import { readCancelZipTargets, invalidateZipBundles } from "../../media/index.js";

const db = useSeededDatabase("services", { label: "portaldown" });
let h: ReturnType<typeof createPortalDownloadFixture>, steps: ReturnType<typeof h.releaseSteps>;
let f: Awaited<ReturnType<typeof steps.push>>, world: Awaited<ReturnType<typeof h.authorize>>;
beforeAll(async () => {
  h = createPortalDownloadFixture(await db.prisma());
  steps = h.releaseSteps();
});
beforeAll(() => steps.prepare());
beforeAll(() => steps.sampleFile());
beforeAll(() => steps.confirmSample());
beforeAll(() => steps.finalEpisode(2));
beforeAll(async () => {
  f = await steps.push();
});
beforeEach(async () => {
  world = await h.authorize(f.o);
});
afterAll(() => h?.close());
const meta = () => ({
  ...world.meta,
  authMethod: "portal" as const,
  sessionId: world.principal.sessionId,
});
const download = (kind: "zip" | "publish_list") =>
  h.portalDownloads.downloadUrls(world.principal, f.item.id, { kind }, meta());
const count = () => h.prisma.deliveryDownloadLog.count({ where: { orderItemId: f.item.id } });
const idem = () => ({
  idem: createIdempotencyContext({
    mode: "required",
    scope: "m.orderItem.downloadGrant.create",
    actor: f.o.viewer.ctx.actor,
    key: uuidv7(),
    request: { method: "POST", body: {}, pathParams: { orderItemId: f.item.id } },
  }),
});

it("GET列表与详情只读、不触碰ZIP状态和保留期；Q9样片页为空", async () => {
  const tables = [
    "delivery_download_log",
    "zip_bundle",
    "media_job",
    "file_ref",
    "download_grant",
    "portal_session",
    "audit_log",
    "outbox_event",
  ];
  const before = await snapshotTables(h.prisma, tables);
  const detail = await h.portalDownloads.release(world.principal, f.item.id);
  expect(detail).toMatchObject({
    deliveryReleaseId: f.release.deliveryReleaseId,
    isDownloadable: true,
    hasPublishList: true,
    episodeCount: 2,
  });
  expect(detail.episodes).toHaveLength(2);
  expect(detail.episodes.every((entry) => entry.lastPortalDownloadAt === null)).toBe(true);
  for (const tab of ["all", "downloadable"] as const) {
    const page = await h.portalDownloads.list(world.principal, { tab, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      orderItemId: f.item.id,
      phase: "to_launch",
      pendingSample: null,
    });
    for (const cursor of [
      "damaged",
      Buffer.from(
        JSON.stringify({ tab: "sample_pending", id: f.item.id, at: h.clock.now().toISOString() }),
      ).toString("base64url"),
    ])
      expect(await h.portalDownloads.list(world.principal, { tab, limit: 1, cursor })).toEqual(
        page,
      );
  }
  expect(
    await h.portalDownloads.list(world.principal, { tab: "sample_pending", limit: 20 }),
  ).toEqual({ items: [], nextCursor: null, hasMore: false });
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
});

it("预排building与只查清单返回200状态形状，重复轮询不多排任务、不记访问", async () => {
  const before = await count(),
    jobs = await h.prisma.mediaJob.count({ where: { kind: "zip_package" } });
  for (let n = 0; n < 2; n++)
    expect(await download("zip")).toMatchObject({
      kind: "zip",
      state: "building",
      pollAfterSec: 5,
      downloadId: null,
      url: null,
    });
  expect(await download("publish_list")).toMatchObject({
    kind: "publish_list",
    state: "building",
    pollAfterSec: null,
    downloadId: null,
    url: null,
  });
  expect(await h.prisma.mediaJob.count({ where: { kind: "zip_package" } })).toBe(jobs);
  expect(await count()).toBe(before);
});

it("真实ZIP回查后逐集/ZIP/清单固定TTL，每次签发独立访问，portal不写相册ack", async () => {
  await h.finishZip(f.release.deliveryReleaseId);
  const before = await count();
  for (const body of [
    { kind: "episode", episodeNo: 1 },
    { kind: "zip" },
    { kind: "publish_list" },
    { kind: "episode", episodeNo: 1 },
  ] as const) {
    const at = h.clock.now(),
      result = await h.portalDownloads.downloadUrls(world.principal, f.item.id, body, meta());
    const ttl = body.kind === "zip" ? 10_800 : 900;
    expect(result.state).toBe("ready");
    expect(new Date(result.expiresAt!).getTime() - at.getTime()).toBe(ttl * 1000);
    const row = await h.prisma.deliveryDownloadLog.findUniqueOrThrow({
      where: { id: result.downloadId! },
    });
    expect(row).toMatchObject({
      kind: body.kind,
      client: "portal",
      actorId: f.o.user.id,
      deliveryReleaseId: f.release.deliveryReleaseId,
      urlTtlSec: ttl,
      clientAck: null,
      clientAckAt: null,
    });
  }
  expect(await count()).toBe(before + 4);
  const detail = await h.portalDownloads.release(world.principal, f.item.id);
  expect(detail.episodes[0]!.lastPortalDownloadAt).not.toBeNull();
  expect(detail.episodes[1]!.lastPortalDownloadAt).toBeNull();
  expect((await h.downloads.release(f.o.viewer, f.item.id)).savedEpisodeCount).toBe(0);
});

it("越店和无效集号都不签发或留痕", async () => {
  const before = await count(),
    signer = vi.spyOn(h.zipMedia, "signDeliveryDownload");
  try {
    await expect(h.portalDownloads.release(world.principal, uuidv7())).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    await expect(
      h.portalDownloads.downloadUrls(
        world.principal,
        uuidv7(),
        { kind: "episode", episodeNo: 1 },
        meta(),
      ),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    await expect(
      h.portalDownloads.downloadUrls(
        world.principal,
        f.item.id,
        { kind: "episode", episodeNo: 3 },
        meta(),
      ),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    expect(signer).not.toHaveBeenCalled();
    expect(await count()).toBe(before);
  } finally {
    signer.mockRestore();
  }
});

it("外呼期间真实logout撤销，最终事务拒绝旧会话且零访问", async () => {
  const before = await count(),
    original = h.zipMedia.signDeliveryDownload;
  const signer = vi.spyOn(h.zipMedia, "signDeliveryDownload").mockImplementation(async (input) => {
    const result = await original(input);
    await world.sessions.logout(world.principal, world.meta);
    return result;
  });
  try {
    await expect(download("zip")).rejects.toMatchObject({
      error: "PORTAL_SESSION_INVALID",
      details: { reason: "revoked" },
    });
    expect(await count()).toBe(before);
  } finally {
    signer.mockRestore();
  }
});

it("外呼期间真实重签授权，旧grant地址不得返回和留痕", async () => {
  const before = await count(),
    original = h.zipMedia.signDeliveryDownload;
  const signer = vi.spyOn(h.zipMedia, "signDeliveryDownload").mockImplementation(async (input) => {
    const result = await original(input);
    await h.downloads.createGrant(f.o.viewer, f.item.id, idem());
    return result;
  });
  try {
    await expect(download("zip")).rejects.toMatchObject({
      error: "DOWNLOAD_GRANT_INVALID",
      details: { reason: "superseded" },
    });
    expect(await count()).toBe(before);
  } finally {
    signer.mockRestore();
  }
});

it("ZIP清单目标不可用时拒绝文件，不把ready ZIP当成清单可读", async () => {
  const input = await h.input(f.release.deliveryReleaseId),
    ready = await h.tx.run((tx) => h.zipMedia.ensureZip(tx, input, { peek: true }));
  const before = await count(),
    fileId = ready.publishListFileId!;
  // 注入对象审核故障，不冒充清理或生产成功。
  const old = await h.prisma.fileObject.findUniqueOrThrow({ where: { id: fileId } });
  await h.prisma.fileObject.update({ where: { id: fileId }, data: { moderationState: "block" } });
  try {
    await expect(download("publish_list")).rejects.toMatchObject({
      error: "DOWNLOAD_NOT_AVAILABLE",
      details: { reason: "file_unavailable" },
    });
    expect(await count()).toBe(before);
  } finally {
    await h.prisma.fileObject.update({
      where: { id: fileId },
      data: { moderationState: old.moderationState },
    });
  }
});

it("外呼期间实际缓存失效，最终peek拒绝旧代且不重新打包", async () => {
  const before = await count(),
    original = h.zipMedia.signDeliveryDownload;
  const jobs = await h.prisma.mediaJob.count({ where: { kind: "zip_package" } });
  const signer = vi.spyOn(h.zipMedia, "signDeliveryDownload").mockImplementation(async (input) => {
    const result = await original(input);
    await h.tx.run(async (tx) =>
      invalidateZipBundles(
        tx,
        await readCancelZipTargets(tx, [f.release.deliveryReleaseId]),
        h.clock.now(),
        { preserveReleaseFiles: true },
      ),
    );
    return result;
  });
  try {
    await expect(download("zip")).rejects.toMatchObject({
      error: "DOWNLOAD_NOT_AVAILABLE",
      details: { reason: "file_unavailable" },
    });
    expect(await count()).toBe(before);
    expect(await h.prisma.mediaJob.count({ where: { kind: "zip_package" } })).toBe(jobs);
  } finally {
    signer.mockRestore();
  }
  expect(await download("publish_list")).toMatchObject({
    state: "none",
    url: null,
    downloadId: null,
    pollAfterSec: null,
  });
  expect(await count()).toBe(before);
});

it("真实ZIP失败维持failed，普通轮询不重打，显式retry才新建一代", async () => {
  expect(await download("zip")).toMatchObject({ state: "building" });
  const bundle = await h.prisma.zipBundle.findUniqueOrThrow({
    where: {
      ownerType_ownerId: { ownerType: "delivery_release", ownerId: f.release.deliveryReleaseId },
    },
  });
  const job = await h.prisma.mediaJob.findFirstOrThrow({
    where: { parentId: bundle.id, state: "queued" },
    orderBy: { createdAt: "desc" },
  });
  h.fake.storage.failNext("putStream", { reason: "unsupported" });
  await h.zipMedia.jobs.run({ jobId: job.id });
  const before = await count(),
    jobs = await h.prisma.mediaJob.count({ where: { parentId: bundle.id } });
  for (let index = 0; index < 2; index++)
    expect(await download("zip")).toMatchObject({
      state: "failed",
      downloadId: null,
      url: null,
      pollAfterSec: null,
    });
  expect(await h.prisma.mediaJob.count({ where: { parentId: bundle.id } })).toBe(jobs);
  expect(
    await h.portalDownloads.downloadUrls(
      world.principal,
      f.item.id,
      { kind: "zip", retry: true },
      meta(),
    ),
  ).toMatchObject({ state: "building" });
  expect(await h.prisma.mediaJob.count({ where: { parentId: bundle.id } })).toBe(jobs + 1);
  expect(await count()).toBe(before);
});

it("签名外呼恰到会话截止立即拒绝，授权到期仍列出blocker而不签发", async () => {
  const before = await count(),
    original = h.zipMedia.signDeliveryDownload;
  const signer = vi.spyOn(h.zipMedia, "signDeliveryDownload").mockImplementation(async (input) => {
    const result = await original(input);
    h.clock.set(new Date(world.principal.view.expiresAt));
    return result;
  });
  try {
    await expect(
      h.portalDownloads.downloadUrls(
        world.principal,
        f.item.id,
        { kind: "episode", episodeNo: 1 },
        meta(),
      ),
    ).rejects.toMatchObject({ error: "PORTAL_SESSION_INVALID", details: { reason: "expired" } });
    expect(await count()).toBe(before);
  } finally {
    signer.mockRestore();
  }
  const grant = await h.prisma.downloadGrant.findFirstOrThrow({
    where: { deliveryReleaseId: f.release.deliveryReleaseId, state: "active" },
  });
  h.clock.set(grant.expiresAt);
  world = await h.authorize(f.o);
  const page = await h.portalDownloads.list(world.principal, { tab: "downloadable", limit: 20 });
  expect(page.items[0]).toMatchObject({
    orderItemId: f.item.id,
    isDownloadable: false,
    downloadBlocker: { kind: "grant_invalid", reason: "expired" },
  });
  expect(await h.portalDownloads.release(world.principal, f.item.id)).toMatchObject({
    isDownloadable: false,
    downloadBlocker: { kind: "grant_invalid", reason: "expired" },
  });
  await expect(download("zip")).rejects.toMatchObject({
    error: "DOWNLOAD_GRANT_INVALID",
    details: { reason: "expired" },
  });
  expect(await count()).toBe(before);
});
