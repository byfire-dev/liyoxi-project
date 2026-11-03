import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DownloadGrantResultSchema,
  DownloadReportResultSchema,
  EpisodeDownloadUrlSchema,
  LicenseVerificationViewSchema,
  PlayableSchema,
  PortalAdDetailSchema,
  PortalAdPageSchema,
  PortalDownloadResultSchema,
  PortalOrderItemPageSchema,
  PortalReleaseViewSchema,
  ReleaseViewSchema,
} from "@liyoxi/contract";
import {
  claimLicenseRevision,
  completeLicenseRevision,
  reconcileLetters,
  runSeed,
  uuidv7,
} from "@liyoxi/services";
import {
  createFactories,
  createDeliveryProductionTools,
  createPortalAdFixture,
  createPortalDownloadFixture,
  createPortalTestSession,
  createPortalTestStack,
  inspectZipFixture,
  openSealed,
  PORTAL_DOWNLOAD_TEST_ORIGIN,
  snapshotTables,
  TEST_KEYRING,
} from "@liyoxi/services/testing";
import type { FakeStorage } from "@liyoxi/services/testing";
import { TEST_WEAPP_APPID, useTestApi } from "../src/testing/index.js";
import type { TestApi, TestRequestInit } from "../src/testing/index.js";
import { signInAsMerchant } from "../src/testing/merchant.js";
import { prepareMixedPortalReads } from "./e2e/mixed-portal-reader.js";

const handle = useTestApi(),
  origin = PORTAL_DOWNLOAD_TEST_ORIGIN;
const csrf = { Origin: origin, "X-LYX-Portal": "1" };
const operations = [
  "m.download.report",
  "m.orderItem.downloadGrant.create",
  "portal.orderItem.list",
  "portal.orderItem.release.get",
  "portal.orderItem.downloadUrls",
  "portal.ad.list",
  "portal.ad.get",
  "portal.ad.playbackUrls",
  "portal.licenseVerification.get",
  "portal.clientError.create",
];
const tables = [
  "order_item",
  "delivery_ticket",
  "delivery_release",
  "download_grant",
  "delivery_download_log",
  "zip_bundle",
  "media_job",
  "file_object",
  "file_ref",
  "portal_session",
  "portal_ticket",
  "ad",
  "ad_version",
  "playable_asset",
  "license_letter",
  "license_letter_revision",
  "audit_log",
  "auth_event",
  "status_transition",
  "outbox_event",
  "timer",
  "idempotency_record",
];
let api: TestApi,
  peer = 0;
async function call(path: string, init: TestRequestInit = {}) {
  return api.request(`/api/v1${path}`, { peer: `198.18.127.${(++peer % 240) + 1}`, ...init });
}
async function ok(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return ((await response.json()) as { data: unknown }).data;
}
function copyProducedObjects(source: FakeStorage) {
  // Both runtimes use isolated in-memory transports. Copy only actual producer output bytes
  // and original metadata; keep the API's real services, signing and guards. This is not cloud evidence.
  const target = api.runtime.providers.storage as FakeStorage;
  for (const [key, object] of source.objects)
    target.objects.set(key, { ...object, body: new Uint8Array(object.body) });
}
const snapshot = async () => snapshotTables(await handle.db.prisma(), tables);
beforeAll(async () => {
  api = await handle.start({
    portalPublicOrigin: origin,
    merchantKeyring: TEST_KEYRING,
    mediaProduction: (providers) => {
      const codec = createDeliveryProductionTools(providers);
      return { config: codec.env, tools: codec.tools };
    },
  });
});
beforeAll(async () => {
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
});

describe("W6-06 下载：真实两集生产、会话与 HTTP", () => {
  let h: ReturnType<typeof createPortalDownloadFixture>;
  let steps: ReturnType<typeof h.releaseSteps>;
  let delivered: Awaited<ReturnType<typeof steps.push>>;
  let world: Awaited<ReturnType<typeof h.authorize>>;
  let portalHeaders: Record<string, string>, merchantHeaders: Record<string, string>;
  let outsideCookie: string, outsideStoreId: string;
  let portalEpisodeId: string;
  const path = () => `/portal/order-items/${delivered.item.id}`;
  const download = (json: unknown, headers = portalHeaders) =>
    call(`${path()}/download-urls`, { method: "POST", headers, json });
  beforeAll(async () => {
    h = createPortalDownloadFixture(await handle.db.prisma(), { appid: TEST_WEAPP_APPID });
    steps = h.releaseSteps(2);
  });
  beforeAll(async () => {
    await steps.prepare();
  });
  beforeAll(async () => {
    await steps.sampleFile();
  });
  beforeAll(async () => {
    await steps.confirmSample();
  });
  beforeAll(async () => {
    await steps.finalEpisode(2);
  });
  beforeAll(async () => {
    delivered = await steps.push();
  });
  beforeAll(async () => {
    world = await h.authorize(delivered.o);
    api.clock.set(h.clock.now());
    copyProducedObjects(h.fake.storage);
    portalHeaders = { ...csrf, Cookie: `__Host-lyx_portal=${world.token}` };
    merchantHeaders = {
      Authorization: `Bearer ${world.merchantToken}`,
      "X-Store-Id": delivered.o.store.id,
      "X-Client-Version": "1.4.0",
    };
    const make = createFactories({ db: await handle.db.prisma(), clock: h.clock });
    outsideStoreId = (await make.store({ entityId: world.principal.entityId })).id;
    const outside = await createPortalTestSession(
      h.portalStack,
      {
        ...world.owner,
        ctx: { ...world.owner.ctx, storeId: outsideStoreId },
      },
      world.meta,
    );
    outsideCookie = `__Host-lyx_portal=${outside.token}`;
  });
  afterAll(async () => {
    await h?.close();
  });

  it("十个 operation 各挂载一次；Q9 两条样片 API 不挂载、不提供回退", async () => {
    expect(api.api.mountedOperations.filter((id) => operations.includes(id)).sort()).toEqual(
      [...operations].sort(),
    );
    for (const id of ["portal.orderItem.sample.get", "portal.sample.playbackUrls"])
      expect(api.api.mountedOperations).not.toContain(id);
    const before = await snapshot();
    expect((await call(`${path()}/sample`, { headers: portalHeaders })).status).toBe(404);
    expect(
      (
        await call(`/portal/samples/${delivered.sample.sampleId}/playback-urls`, {
          method: "POST",
          headers: portalHeaders,
          json: {},
        })
      ).status,
    ).toBe(404);
    const pending = PortalOrderItemPageSchema.parse(
      await ok(await call("/portal/order-items?tab=sample_pending", { headers: portalHeaders })),
    );
    expect(pending).toMatchObject({ items: [], hasMore: false, nextCursor: null });
    expect(await snapshot()).toEqual(before);
  });

  it("列表与当前包 GET 零写，客户端门店头不能改变真实会话范围", async () => {
    const before = await snapshot();
    const list = PortalOrderItemPageSchema.parse(
      await ok(
        await call("/portal/order-items?tab=downloadable", {
          headers: { ...portalHeaders, "X-Store-Id": outsideStoreId },
        }),
      ),
    );
    expect(list.items.map((item) => item.orderItemId)).toEqual([delivered.item.id]);
    expect(list.items[0]).toMatchObject({
      isDownloadable: true,
      pendingSample: null,
      downloadBlocker: null,
    });
    const release = PortalReleaseViewSchema.parse(
      await ok(await call(`${path()}/release`, { headers: portalHeaders })),
    );
    expect(release).toMatchObject({
      deliveryReleaseId: delivered.release.deliveryReleaseId,
      episodeCount: 2,
      isDownloadable: true,
    });
    expect(release.episodes.map((row) => row.episodeNo)).toEqual([1, 2]);
    expect(release.episodes.every((row) => row.lastPortalDownloadAt === null)).toBe(true);
    const outside = await call(`${path()}/release`, {
      headers: { Cookie: outsideCookie, "X-Store-Id": delivered.o.store.id },
    });
    expect(outside.status).toBe(404);
    expect(await outside.json()).toMatchObject({ error: "NOT_FOUND" });
    const empty = PortalOrderItemPageSchema.parse(
      await ok(await call("/portal/order-items", { headers: { Cookie: outsideCookie } })),
    );
    expect(empty.items).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("无会话、跨门店、错误 Origin/header 与客户端注入文件均拒绝且不留下载记录", async () => {
    const before = await snapshot();
    expect((await download({ kind: "episode", episodeNo: 1 }, csrf)).status).toBe(401);
    const outside = await download(
      { kind: "episode", episodeNo: 1 },
      { ...csrf, Cookie: outsideCookie },
    );
    expect(outside.status).toBe(404);
    const rejectedHeaders: Record<string, string>[] = [
      { Cookie: portalHeaders.Cookie! },
      { ...portalHeaders, Origin: "https://other.example.invalid" },
      { ...portalHeaders, "X-LYX-Portal": "0" },
    ];
    for (const headers of rejectedHeaders)
      expect((await download({ kind: "episode", episodeNo: 1 }, headers)).status).toBe(403);
    expect((await download({ kind: "episode", episodeNo: 1, fileId: uuidv7() })).status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it("单集每次真实签发独立记录和 900 秒地址；GET 仅读最新 portal 访问", async () => {
    const one = PortalDownloadResultSchema.parse(
      await ok(await download({ kind: "episode", episodeNo: 1 })),
    );
    const two = PortalDownloadResultSchema.parse(
      await ok(await download({ kind: "episode", episodeNo: 1 })),
    );
    expect(one).toMatchObject({ kind: "episode", state: "ready", episodeNo: 1 });
    expect(two.downloadId).not.toBe(one.downloadId);
    portalEpisodeId = one.downloadId!;
    expect(Date.parse(one.expiresAt!) - api.clock.now().getTime()).toBe(900_000);
    const storage = api.runtime.providers.storage as FakeStorage;
    const read = storage.fetch(one.url!);
    expect(read.status).toBe(200);
    const row = await h.prisma.deliveryDownloadLog.findUniqueOrThrow({
      where: { id: one.downloadId! },
    });
    expect(row).toMatchObject({
      client: "portal",
      kind: "episode",
      episodeNo: 1,
      urlTtlSec: 900,
      clientAck: null,
      actorId: world.principal.merchantUserId,
    });
    const file = await h.prisma.fileObject.findUniqueOrThrow({ where: { id: row.fileId } });
    if (read.status !== 200) throw new Error("signed fixture episode cannot be read");
    expect(read.body).toEqual(h.fake.storage.objects.get(`${file.bucket}/${file.objectKey}`)!.body);
    const before = await snapshot();
    const release = PortalReleaseViewSchema.parse(
      await ok(await call(`${path()}/release`, { headers: portalHeaders })),
    );
    expect(release.episodes[0]!.lastPortalDownloadAt).toBe(api.clock.now().toISOString());
    expect(await snapshot()).toEqual(before);
  });

  it("小程序 report 必须有幂等键，只认自己的小程序逐集签发；保存后当前包进度读回", async () => {
    const wrongChannel = await call(`/m/downloads/${portalEpisodeId}/report`, {
      method: "POST",
      headers: { ...merchantHeaders, "Idempotency-Key": uuidv7() },
      json: { result: "saved" },
    });
    expect(wrongChannel.status).toBe(404);
    const issued = EpisodeDownloadUrlSchema.parse(
      await ok(
        await call(`/m/order-items/${delivered.item.id}/download-urls`, {
          method: "POST",
          headers: merchantHeaders,
          json: { kind: "episode", episodeNo: 2 },
        }),
      ),
    );
    const reportPath = `/m/downloads/${issued.downloadId}/report`;
    expect(
      (
        await call(reportPath, {
          method: "POST",
          headers: merchantHeaders,
          json: { result: "saved" },
        })
      ).status,
    ).toBe(400);
    const headers = { ...merchantHeaders, "Idempotency-Key": uuidv7() };
    const first = DownloadReportResultSchema.parse(
      await ok(await call(reportPath, { method: "POST", headers, json: { result: "saved" } })),
    );
    expect(first).toMatchObject({
      downloadId: issued.downloadId,
      episodeNo: 2,
      clientAck: "saved",
    });
    const before = await snapshot();
    const replay = await call(reportPath, { method: "POST", headers, json: { result: "saved" } });
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await ok(replay)).toEqual(first);
    const release = ReleaseViewSchema.parse(
      await ok(
        await call(`/m/order-items/${delivered.item.id}/release`, { headers: merchantHeaders }),
      ),
    );
    expect(release.savedEpisodeCount).toBe(1);
    expect(release.episodes[1]!.lastSavedAt).toBe(first.clientAckAt);
    expect(await snapshot()).toEqual(before);
  });

  it("重新授权必须幂等，重放不再消耗每日次数且门户读回新到期时间", async () => {
    const grantPath = `/m/order-items/${delivered.item.id}/download-grants`;
    expect(
      (await call(grantPath, { method: "POST", headers: merchantHeaders, json: {} })).status,
    ).toBe(400);
    const headers = { ...merchantHeaders, "Idempotency-Key": uuidv7() };
    const first = DownloadGrantResultSchema.parse(
      await ok(await call(grantPath, { method: "POST", headers, json: {} })),
    );
    expect(first.regrantRemainingToday).toBe(4);
    const before = await snapshot();
    const replay = await call(grantPath, { method: "POST", headers, json: {} });
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await ok(replay)).toEqual(first);
    const release = PortalReleaseViewSchema.parse(
      await ok(await call(`${path()}/release`, { headers: portalHeaders })),
    );
    expect(release.grant).toMatchObject({
      state: "active",
      expiresAt: first.grant.expiresAt,
      isExpired: false,
    });
    expect(await snapshot()).toEqual(before);
  });

  it("ZIP 排队时仍 HTTP 200/building，发布清单不触发额外任务", async () => {
    const jobs = await h.prisma.mediaJob.count({ where: { kind: "zip_package" } });
    const pending = PortalDownloadResultSchema.parse(await ok(await download({ kind: "zip" })));
    expect(pending).toMatchObject({
      kind: "zip",
      state: "building",
      url: null,
      downloadId: null,
      pollAfterSec: 5,
    });
    const list = PortalDownloadResultSchema.parse(
      await ok(await download({ kind: "publish_list" })),
    );
    expect(list).toMatchObject({
      kind: "publish_list",
      state: "building",
      url: null,
      downloadId: null,
      pollAfterSec: null,
    });
    expect(await h.prisma.mediaJob.count({ where: { kind: "zip_package" } })).toBe(jobs);
  });

  describe("真实 ZIP runner 完成之后", () => {
    beforeAll(async () => {
      await h.finishZip(delivered.release.deliveryReleaseId);
      api.clock.set(h.clock.now());
      copyProducedObjects(h.fake.storage);
    });
    it("ZIP 与发布清单 HTTP 200/ready 取到真实字节，分别使用 3 小时与 15 分钟签名", async () => {
      const zip = PortalDownloadResultSchema.parse(await ok(await download({ kind: "zip" })));
      const list = PortalDownloadResultSchema.parse(
        await ok(await download({ kind: "publish_list" })),
      );
      const storage = api.runtime.providers.storage as FakeStorage;
      const zipRead = storage.fetch(zip.url!),
        listRead = storage.fetch(list.url!);
      expect(zipRead.status).toBe(200);
      expect(listRead.status).toBe(200);
      expect(zip).toMatchObject({ state: "ready", pollAfterSec: null });
      expect(Date.parse(zip.expiresAt!) - api.clock.now().getTime()).toBe(10_800_000);
      expect(Date.parse(list.expiresAt!) - api.clock.now().getTime()).toBe(900_000);
      if (zipRead.status !== 200 || listRead.status !== 200)
        throw new Error("produced ZIP/list cannot be read");
      const archive = inspectZipFixture(zipRead.body);
      expect(archive.fileCount).toBe(3);
      expect(archive.entries.map((entry) => entry.name)).toContain("发布清单.txt");
      const release = await h.prisma.deliveryRelease.findUniqueOrThrow({
        where: { id: delivered.release.deliveryReleaseId },
      });
      expect(Buffer.from(listRead.body).toString("utf8")).toBe(release.publishListText);
    });
    it("真实退出撤销会话后，内容读取与签发均拒绝且零写", async () => {
      await ok(
        await call("/portal/sessions/current", { method: "DELETE", headers: portalHeaders }),
      );
      const before = await snapshot();
      for (const response of [
        await call(`${path()}/release`, { headers: portalHeaders }),
        await download({ kind: "episode", episodeNo: 1 }),
      ]) {
        expect(response.status).toBe(401);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(await response.json()).toMatchObject({
          error: "PORTAL_SESSION_INVALID",
          details: { reason: "revoked" },
        });
      }
      expect(await snapshot()).toEqual(before);
    });
  });
});

describe("W6-06 广告预览与公开授权验真 HTTP", () => {
  let h: Awaited<ReturnType<typeof createPortalAdFixture>>;
  let version: Awaited<ReturnType<typeof h.push>>;
  let portalHeaders: Record<string, string>,
    verifyCode: string,
    letterId: string,
    revisionId: string;
  beforeAll(async () => {
    h = await createPortalAdFixture(await handle.db.prisma(), {
      databaseUrl: await handle.db.url(),
      redisUrl: process.env.REDIS_URL!,
      redisKeyPrefix: handle.redis.prefix,
      clock: api.clock,
    });
  });
  beforeAll(async () => {
    await h.playback(false);
    version = await h.push();
  });
  beforeAll(async () => {
    await h.start();
  });
  beforeAll(async () => {
    await h.runtime.tx.run((tx) =>
      reconcileLetters(tx, h.licenseDeps, [h.order.itemId], "test:portal-http-verification"),
    );
    const letter = await (
      await handle.db.prisma()
    ).licenseLetter.findFirstOrThrow({
      where: { orderItemId: h.order.itemId },
      include: { revisions: true },
      orderBy: { id: "asc" },
    });
    letterId = letter.id;
    verifyCode = letter.verifyCode;
    revisionId = letter.revisions[0]!.id;
  });
  beforeAll(async () => {
    const claim = await h.runtime.tx.run((tx) =>
      claimLicenseRevision(tx, h.runtime.docsRender.queue, revisionId),
    );
    if (!claim) throw new Error("verification HTTP fixture could not claim revision");
    // Explicit PDF transport replacement verifies publication state, not typography/signature acceptance.
    const file = await h.runtime.media.putSystemFile({
      category: "legal_doc",
      fileName: "portal-verification.pdf",
      body: Buffer.from(`%PDF-1.7\n% portal HTTP verification ${revisionId}\n%%EOF`),
      objectKey: `legal/portal-verification/${revisionId}.pdf`,
      entityId: claim.entityId,
      storeId: null,
    });
    expect(
      await h.runtime.tx.run((tx) =>
        completeLicenseRevision(tx, h.runtime.docsRender.queue, claim, {
          fileId: file.fileId,
          pdfSha256: file.sha256,
          signMode: "stamp",
          platformSignedAt: h.clock.now(),
        }),
      ),
    ).toBe(true);
  });
  beforeAll(async () => {
    // Real order.start may advance the shared clock. Authorize only after those producers finish.
    const stack = createPortalTestStack({
      tx: h.runtime.tx,
      clock: h.clock,
      appid: "wx0000000000000000",
      origin,
      ticketTtlSeconds: 120,
    });
    const world = await createPortalTestSession(
      stack,
      { ctx: h.actor.ctx, principal: h.actor.principal },
      {
        requestId: uuidv7(),
        ip: "198.18.127.250",
        userAgent: "Portal AD HTTP test",
        clientVersion: "1.4.0",
      },
    );
    portalHeaders = { ...csrf, Cookie: `__Host-lyx_portal=${world.token}` };
    copyProducedObjects(h.providers.storage);
  });
  afterAll(async () => {
    await h?.close();
  });

  it("广告读取要求会话，播放签发保留同源校验及当前版本守卫", async () => {
    const before = await snapshot(),
      path = `/portal/ads/${h.created.adId}`;
    expect((await call(path)).status).toBe(401);
    expect(
      (
        await call(`${path}/playback-urls`, {
          method: "POST",
          headers: { Cookie: portalHeaders.Cookie! },
          json: { versionNo: version.versionNo },
        })
      ).status,
    ).toBe(403);
    const stale = await call(`${path}/playback-urls`, {
      method: "POST",
      headers: portalHeaders,
      json: { versionNo: version.versionNo + 1 },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "AD_VERSION_STALE" });
    expect(await snapshot()).toEqual(before);
  });

  it("广告列表与详情 GET 零写且不泄露源文件；真正签发播放源后可读并写 portal 访问证据", async () => {
    const before = await snapshot();
    const list = PortalAdPageSchema.parse(
      await ok(await call("/portal/ads", { headers: portalHeaders })),
    );
    expect(list.items.map((row) => row.adId)).toContain(h.created.adId);
    const detail = PortalAdDetailSchema.parse(
      await ok(await call(`/portal/ads/${h.created.adId}`, { headers: portalHeaders })),
    );
    expect(detail).toMatchObject({
      isPortalPreviewable: true,
      currentVersion: { versionNo: version.versionNo },
    });
    expect(detail).not.toHaveProperty("playable");
    expect(detail.currentVersion).not.toHaveProperty("fileId");
    expect(await snapshot()).toEqual(before);
    const playable = PlayableSchema.parse(
      await ok(
        await call(`/portal/ads/${h.created.adId}/playback-urls`, {
          method: "POST",
          headers: portalHeaders,
          json: { versionNo: version.versionNo },
        }),
      ),
    );
    expect(playable.kind).toBe("ad");
    expect(Date.parse(playable.expiresAt!) - api.clock.now().getTime()).toBe(3_600_000);
    expect(
      (api.runtime.providers.storage as FakeStorage).fetch(playable.sources[0]!.url).status,
    ).toBe(200);
    const log = await (
      await handle.db.prisma()
    ).auditLog.findFirstOrThrow({
      where: { action: "ad.version.portal_preview", targetId: version.adVersionId },
      orderBy: { seq: "desc" },
    });
    expect(log).toMatchObject({
      stream: "access",
      client: "portal",
      actorId: h.actor.principal.merchantUserId,
      authMethod: "portal",
      meta: { urlTtlSec: 3600 },
    });
  });

  it("公开验真无 Cookie 也返回已出件 proof，非法码仍 404，GET 不写且不暴露内部标识/PDF", async () => {
    const owner = await signInAsMerchant(api, {
      phone: openSealed("merchant_user.phone_enc", h.merchant.user.phoneEnc!),
    });
    expect(owner.merchantUserId).toBe(h.merchant.user.id);
    const before = await snapshot();
    const prepared = await prepareMixedPortalReads(
      { request: api.request },
      {
        operationIds: ["portal.licenseVerification.get"],
        merchantHeaders: owner.withStore(h.merchant.store.id),
        licenseScope: {
          orderId: h.order.id,
          orderItemId: h.order.itemId,
          storeId: h.merchant.store.id,
        },
        origin: api.runtime.env.PORTAL_PUBLIC_ORIGIN,
        signal: new AbortController().signal,
      },
    );
    try {
      expect(prepared.licenseVerificationCode).toBe(verifyCode);
      expect(prepared.lookupCode).toBe("");
      expect(prepared.headers).toEqual({});
    } finally {
      await prepared.close();
    }
    const view = LicenseVerificationViewSchema.parse(
      await ok(await call(`/portal/license-verifications?code=${verifyCode}&revNo=1`)),
    );
    expect(view).toMatchObject({
      requestedRevisionState: "current",
      currentRevision: { revNo: 1, signMode: "stamp" },
      hasPendingRevision: false,
    });
    const row = await (
      await handle.db.prisma()
    ).licenseLetterRevision.findUniqueOrThrow({ where: { id: revisionId } });
    expect(view.currentRevision.pdfSha256).toBe(row.pdfSha256);
    for (const secret of [letterId, revisionId, row.fileId!])
      expect(JSON.stringify(view)).not.toContain(secret);
    for (const key of ["pdfUrl", "fileId", "entityId", "storeId", "letterSnapshot"])
      expect(view).not.toHaveProperty(key);
    const missing = await call("/portal/license-verifications?code=bad-code");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "LICENSE_VERIFICATION_NOT_FOUND" });
    expect(await snapshot()).toEqual(before);
  });
});
