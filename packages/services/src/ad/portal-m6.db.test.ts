import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PortalAdListQuerySchema } from "@liyoxi/contract";
import { assertPortalPrincipal } from "../identity/index.js";
import type { PortalPrincipal } from "../identity/index.js";
import {
  createFactories,
  createPortalTestSession,
  createPortalTestStack,
  prepareAdVideoForTest,
  snapshotTables,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { adFixture } from "./__fixtures__/lifecycle.js";
import { createPortalAds } from "./portal.js";

const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
const meta = {
  requestId: "portal-ad-m6",
  ip: "198.19.1.2",
  userAgent: "portal-ad-test",
  clientVersion: null,
};
const tables = [
  "ad",
  "ad_version",
  "playable_asset",
  "file_object",
  "file_ref",
  "portal_session",
  "audit_log",
  "auth_event",
  "status_transition",
  "outbox_event",
  "timer",
  "delivery_download_log",
];
let h: Awaited<ReturnType<typeof adFixture>>;
let api: ReturnType<typeof createPortalAds>;
let stack: ReturnType<typeof createPortalTestStack>;
let principal: PortalPrincipal;
let first: Awaited<ReturnType<typeof h.push>>;
let secondId: string;
let secondFile: Awaited<ReturnType<typeof prepareAdVideoForTest>>;
beforeAll(async () => {
  h = await adFixture(await db.prisma(), {
    databaseUrl: await db.url(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: redis.prefix,
  });
  api = createPortalAds({
    tx: h.runtime.tx,
    clock: h.clock,
    media: h.runtime.media,
    assertPortalPrincipal,
    playback: (entityId) =>
      h.runtime.config.flags.isEnabled("weapp.video.ad.enabled", { entityId }),
  });
  stack = createPortalTestStack({
    tx: h.runtime.tx,
    clock: h.clock,
    appid: "wx0000000000000000",
    origin: "https://portal.example.invalid",
    ticketTtlSeconds: 120,
  });
});
beforeAll(async () => {
  await h.playback(true);
  first = await h.push();
});
beforeAll(async () => {
  secondId = (await h.runtime.ads.create(h.actor, h.createBody)).adId;
  await h.runtime.tx.run((tx) =>
    h.runtime.ads.production.assignTx(tx, h.adminActor, secondId, h.editorId),
  );
});
beforeAll(async () => {
  secondFile = await prepareAdVideoForTest(h, await db.prisma(), secondId, h.staffActor);
});
beforeAll(async () => {
  await h.playback(false);
  const version = await h.runtime.tx.run((tx) =>
    h.runtime.ads.production.registerVersionTx(tx, h.staffActor, secondId, secondFile),
  );
  await h.runtime.tx.run((tx) =>
    h.runtime.ads.production.pushVersionTx(tx, h.staffActor, version.adVersionId),
  );
  await h.playback(true);
});
beforeEach(async () => {
  await h.playback(false);
  const session = await createPortalTestSession(
    stack,
    { ctx: h.actor.ctx, principal: h.actor.principal! },
    meta,
  );
  principal = await stack.sessions.authenticate(session.token);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await h?.close();
});
const input = () => ({ versionNo: first.versionNo });
const auditMeta = () => ({
  ...meta,
  authMethod: "portal" as const,
  sessionId: principal.sessionId,
});
const logs = async () =>
  (await db.prisma()).auditLog.count({ where: { action: "ad.version.portal_preview" } });

it("当前推送版本的渠道与实时开关兜底一致；游标分页不漏项，GET只签封面且全表零写", async () => {
  await h.playback(true);
  expect(
    (await api.list(principal, PortalAdListQuerySchema.parse({}))).items.map((row) => row.adId),
  ).toEqual([secondId]);
  expect((await api.get(principal, h.created.adId)).isPortalPreviewable).toBe(false);
  await expect(
    api.playbackUrls(principal, h.created.adId, input(), auditMeta()),
  ).rejects.toMatchObject({ error: "AD_PREVIEW_CHANNEL_UNAVAILABLE" });
  await h.playback(false);
  const p = await db.prisma(),
    before = await snapshotTables(p, tables);
  const firstPage = await api.list(principal, PortalAdListQuerySchema.parse({ limit: 1 }));
  const nextPage = await api.list(
    principal,
    PortalAdListQuerySchema.parse({ limit: 1, cursor: firstPage.nextCursor }),
  );
  expect(firstPage.hasMore).toBe(true);
  expect(nextPage.hasMore).toBe(false);
  expect(new Set([...firstPage.items, ...nextPage.items].map((row) => row.adId))).toEqual(
    new Set([h.created.adId, secondId]),
  );
  const detail = await api.get(principal, h.created.adId);
  expect(detail).toMatchObject({
    isPortalPreviewable: true,
    currentVersion: { versionNo: first.versionNo },
  });
  expect(detail).not.toHaveProperty("playable");
  expect(detail).not.toHaveProperty("chargePoints");
  expect(detail.currentVersion).not.toHaveProperty("fileId");
  expect(await snapshotTables(p, tables)).toEqual(before);
});

it("真实另一门店会话不能读取或签发，伪造principal范围也不被信任；未推送广告404", async () => {
  const p = await db.prisma(),
    make = createFactories({ db: p, clock: h.clock });
  const otherStore = await make.store({ entityId: principal.entityId });
  const other = await createPortalTestSession(
    stack,
    {
      ctx: { ...h.actor.ctx, storeId: otherStore.id },
      principal: h.actor.principal!,
    },
    meta,
  );
  const otherPrincipal = await stack.sessions.authenticate(other.token);
  await expect(api.get(otherPrincipal, h.created.adId)).rejects.toMatchObject({
    error: "NOT_FOUND",
  });
  await expect(
    api.playbackUrls(otherPrincipal, h.created.adId, input(), auditMeta()),
  ).rejects.toMatchObject({ error: "NOT_FOUND" });
  await expect(
    api.get({ ...principal, storeId: otherStore.id }, h.created.adId),
  ).rejects.toMatchObject({ error: "PORTAL_SESSION_INVALID" });
  const unpushed = await h.runtime.ads.create(h.actor, h.createBody);
  await expect(api.get(principal, unpushed.adId)).rejects.toMatchObject({ error: "NOT_FOUND" });
  await expect(
    api.playbackUrls(principal, unpushed.adId, { versionNo: 1 }, auditMeta()),
  ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
});

it("签名失败与非法版本均无假访问；每次真实签发均3600秒且只写portal证据，可供原确认守卫消费", async () => {
  const before = await logs();
  await expect(
    api.playbackUrls(principal, h.created.adId, { versionNo: first.versionNo + 1 }, auditMeta()),
  ).rejects.toMatchObject({ error: "AD_VERSION_STALE" });
  h.providers.storage.failNext("presignGet");
  await expect(
    api.playbackUrls(principal, h.created.adId, input(), auditMeta()),
  ).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
  expect(await logs()).toBe(before);
  const a = await api.playbackUrls(principal, h.created.adId, input(), auditMeta());
  await api.playbackUrls(principal, h.created.adId, input(), auditMeta());
  expect(a).toMatchObject({
    kind: "ad",
    autoplay: false,
    muted: false,
    sources: [expect.objectContaining({ quality: "source" })],
  });
  expect(Date.parse(a.expiresAt!) - h.clock.now().getTime()).toBe(3_600_000);
  expect(h.providers.storage.fetch(a.sources[0]!.url).status).toBe(200);
  expect(await logs()).toBe(before + 2);
  const p = await db.prisma();
  expect(
    await p.auditLog.findFirst({
      where: { action: "ad.version.portal_preview", targetId: first.adVersionId },
      orderBy: { seq: "desc" },
    }),
  ).toMatchObject({
    stream: "access",
    category: "file_access",
    client: "portal",
    actorType: "merchant",
    actorId: principal.merchantUserId,
    sessionId: principal.sessionId,
    authMethod: "portal",
    entityId: principal.entityId,
    storeId: principal.storeId,
    meta: { fileCategory: "ad_video", urlTtlSec: 3600 },
  });
  expect(
    await p.auditLog.count({
      where: { targetId: first.adVersionId, action: "ad.version.album_download" },
    }),
  ).toBe(0);
  expect(
    (
      await h.runtime.ads.confirm(h.actor, h.created.adId, {
        versionNo: first.versionNo,
        viewedVia: "weapp",
        hasViewed: true,
      })
    ).status,
  ).toBe("confirmed");
});

it("签名期间真实撤销会话，最终事务拒绝且不写访问", async () => {
  const before = await logs(),
    sign = h.runtime.media.signRead.bind(h.runtime.media);
  vi.spyOn(h.runtime.media, "signRead").mockImplementationOnce(async (value) => {
    const result = await sign(value);
    await stack.sessions.logout(principal, meta);
    return result;
  });
  await expect(
    api.playbackUrls(principal, h.created.adId, input(), auditMeta()),
  ).rejects.toMatchObject({ error: "PORTAL_SESSION_INVALID", details: { reason: "revoked" } });
  expect(await logs()).toBe(before);
});

it("签名跨过会话到期，最终拒绝且GET不修复会话或补证据", async () => {
  const before = await logs(),
    now = h.clock.now(),
    sign = h.runtime.media.signRead.bind(h.runtime.media);
  vi.spyOn(h.runtime.media, "signRead").mockImplementationOnce(async (value) => {
    const result = await sign(value);
    h.clock.set(new Date(principal.view.expiresAt));
    return result;
  });
  try {
    await expect(
      api.playbackUrls(principal, h.created.adId, input(), auditMeta()),
    ).rejects.toMatchObject({ error: "PORTAL_SESSION_INVALID", details: { reason: "expired" } });
    const p = await db.prisma(),
      snapshot = await snapshotTables(p, tables);
    await expect(api.get(principal, h.created.adId)).rejects.toMatchObject({
      error: "PORTAL_SESSION_INVALID",
    });
    expect(await snapshotTables(p, tables)).toEqual(snapshot);
    expect(await logs()).toBe(before);
  } finally {
    h.clock.set(now);
  }
});

describe("实际新版本推送发生在签名之后", () => {
  let next: Awaited<ReturnType<typeof h.runtime.ads.production.registerVersionTx>>;
  let file: Awaited<ReturnType<typeof prepareAdVideoForTest>>;
  beforeAll(async () => {
    await h.runtime.ads.requestChange(h.actor, h.created.adId, {
      versionNo: first.versionNo,
      note: "准备新版本竞态",
    });
  });
  beforeAll(async () => {
    file = await prepareAdVideoForTest(h, await db.prisma(), h.created.adId, h.staffActor);
  });
  beforeAll(async () => {
    next = await h.runtime.tx.run((tx) =>
      h.runtime.ads.production.registerVersionTx(tx, h.staffActor, h.created.adId, file),
    );
  });
  it("未推新版不覆盖当前投影；签名后的真实推送使旧版本拒绝，无旧版新访问", async () => {
    expect((await api.get(principal, h.created.adId)).currentVersionNo).toBe(first.versionNo);
    const before = await logs(),
      sign = h.runtime.media.signRead.bind(h.runtime.media);
    vi.spyOn(h.runtime.media, "signRead").mockImplementationOnce(async (value) => {
      const result = await sign(value);
      await h.runtime.tx.run((tx) =>
        h.runtime.ads.production.pushVersionTx(tx, h.staffActor, next.adVersionId),
      );
      return result;
    });
    await expect(
      api.playbackUrls(principal, h.created.adId, input(), auditMeta()),
    ).rejects.toMatchObject({
      error: "AD_VERSION_STALE",
      details: { currentVersionNo: next.versionNo },
    });
    expect(await logs()).toBe(before);
    expect((await api.get(principal, h.created.adId)).currentVersionNo).toBe(next.versionNo);
  });
});
