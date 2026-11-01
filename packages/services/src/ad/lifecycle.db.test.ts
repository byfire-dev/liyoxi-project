import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSeededDatabase, useTestRedis, snapshotTables } from "../testing/index.js";
import { AppError, createIdempotencyContext, uuidv7 } from "../kernel/index.js";
import { readAdOrderFacts } from "./read-facts.js";
import { adMerchantFacts } from "./merchant-facts.js";
import { adFixture } from "./__fixtures__/lifecycle.js";
const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
let active: Awaited<ReturnType<typeof adFixture>> | undefined;
beforeEach(() => db.reset(), 120_000);
afterEach(async () => {
  await active?.close();
  active = undefined;
});
it(
  "真实广告冻结、指派扣减、版次probe与推送、相册证据确认构成可选广告；GET不追加证据",
  { timeout: 120_000 },
  async () => {
    const p = await db.prisma(),
      f = (active = await adFixture(p, {
        databaseUrl: await db.url(),
        redisUrl: process.env.REDIS_URL!,
        redisKeyPrefix: redis.prefix,
      })),
      id = f.created.adId;
    const hold = await p.pointHold.findUniqueOrThrow({
      where: { id: (await p.ad.findUniqueOrThrow({ where: { id } })).pointHoldId },
    });
    expect(hold.status).toBe("captured");
    expect(hold.capturedAt).not.toBeNull();
    await f.playback(false);
    const v = await f.push();
    await expect(
      f.runtime.ads.confirm(f.actor, id, {
        versionNo: v.versionNo,
        viewedVia: "album",
        hasViewed: true,
      }),
    ).rejects.toMatchObject({ error: "AD_NOT_VIEWED" });
    const before = await p.auditLog.count({
        where: { targetType: "ad_version", targetId: v.adVersionId, stream: "access" },
      }),
      detail = await f.runtime.ads.get(f.actor, id);
    expect(detail.currentVersion?.versionNo).toBe(v.versionNo);
    expect(detail.playable?.sources).toEqual([]);
    expect(detail.alternatives.canSaveToAlbum).toBe(true);
    expect(
      await p.auditLog.count({
        where: { targetType: "ad_version", targetId: v.adVersionId, stream: "access" },
      }),
    ).toBe(before);
    const failedSign = vi
      .spyOn(f.runtime.media, "signDeliveryDownload")
      .mockRejectedValueOnce(new AppError("PROVIDER_UNAVAILABLE"));
    await expect(
      f.runtime.ads.download(f.actor, id, { versionNo: v.versionNo }),
    ).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
    failedSign.mockRestore();
    expect(
      await p.auditLog.count({
        where: { targetType: "ad_version", targetId: v.adVersionId, stream: "access" },
      }),
    ).toBe(before);
    await expect(
      f.runtime.ads.confirm(f.actor, id, {
        versionNo: v.versionNo,
        viewedVia: "album",
        hasViewed: true,
      }),
    ).rejects.toMatchObject({ error: "AD_NOT_VIEWED" });
    const download = await f.runtime.ads.download(f.actor, id, { versionNo: v.versionNo });
    expect(
      await p.auditLog.findFirst({
        where: {
          targetType: "ad_version",
          targetId: v.adVersionId,
          action: "ad.version.album_download",
        },
        orderBy: { seq: "desc" },
      }),
    ).toMatchObject({
      category: "file_access",
      meta: { versionNo: v.versionNo, fileCategory: "ad_video", urlTtlSec: 900 },
    });
    expect(new Date(download.expiresAt).getTime() - f.clock.now().getTime()).toBe(900_000);
    const confirmed = await f.runtime.ads.confirm(f.actor, id, {
      versionNo: v.versionNo,
      viewedVia: "album",
      hasViewed: true,
    });
    expect(confirmed.status).toBe("confirmed");
    const facts = await f.runtime.tx.run((tx) =>
      readAdOrderFacts(tx, { ...f.actor.membership, adIds: [id] }),
    );
    expect(facts.rows[0]).toMatchObject({
      adId: id,
      status: "confirmed",
      confirmedVersion: { versionNo: v.versionNo, mediaReady: true },
    });
    const counts = await f.runtime.tx.run((tx) =>
      adMerchantFacts(tx, {
        entityId: f.actor.membership.entityId,
        storeIds: [f.actor.membership.storeId],
        viewerRole: "owner",
        merchantUserId: f.actor.ctx.actor.id,
        now: f.clock.now(),
      }),
    );
    expect(counts.stores[f.actor.membership.storeId]).toMatchObject({
      readyCount: 1,
      revisingCount: 0,
      pendingConfirmCount: 0,
    });
    await expect(
      f.runtime.ads.get({ ...f.actor, membership: { ...f.actor.membership, role: "clerk" } }, id),
    ).rejects.toMatchObject({ error: "ROLE_FORBIDDEN" });
  },
);

it(
  "默认weapp使用真实source资产确认；报价零写，同键重放不重审且异体拒绝",
  { timeout: 120_000 },
  async () => {
    const p = await db.prisma(),
      f = (active = await adFixture(p, {
        databaseUrl: await db.url(),
        redisUrl: process.env.REDIS_URL!,
        redisKeyPrefix: redis.prefix,
      }));
    const tables = [
      "ad",
      "point_hold",
      "ledger_operation",
      "point_ledger_entry",
      "agreement_consent",
      "status_transition",
      "audit_log",
      "outbox_event",
      "timer",
    ];
    const quoted = await snapshotTables(p, tables);
    await f.runtime.ads.quote(f.actor, { type: "opening", durationSec: 3 });
    expect(await snapshotTables(p, tables)).toEqual(quoted);
    await f.playback(true);
    const v = await f.push(),
      detail = await f.runtime.ads.get(f.actor, f.created.adId);
    expect(detail.playable?.kind).toBe("ad");
    expect(detail.playable?.sources).toHaveLength(1);
    expect(detail.playable?.sources[0]?.quality).toBe("source");
    expect(
      (
        await f.runtime.ads.confirm(f.actor, f.created.adId, {
          versionNo: v.versionNo,
          viewedVia: "weapp",
        })
      ).status,
    ).toBe("confirmed");
    const body = { ...f.createBody, copy: "同一真实需求" },
      key = uuidv7(),
      idem = (value: unknown) =>
        createIdempotencyContext({
          mode: "required",
          scope: "m.ad.create",
          actor: f.actor.ctx.actor,
          key,
          request: { method: "POST", body: value, storeId: f.actor.membership.storeId },
        });
    const created = await f.runtime.ads.create(f.actor, body, { idem: idem(body) }),
      settled = await snapshotTables(p, tables),
      calls = f.providers.wechat.callsOf("checkText").length;
    f.providers.wechat.setTextCheckAvailable(false);
    expect(await f.runtime.ads.create(f.actor, body, { idem: idem(body) })).toEqual(created);
    expect(f.providers.wechat.callsOf("checkText")).toHaveLength(calls);
    await expect(
      f.runtime.ads.create(
        f.actor,
        { ...body, copy: "异体内容" },
        { idem: idem({ ...body, copy: "异体内容" }) },
      ),
    ).rejects.toMatchObject({ error: "IDEMPOTENCY_KEY_REUSED" });
    expect(await snapshotTables(p, tables)).toEqual(settled);
  },
);

it(
  "首店在审只冻结不扣减，退回后重提不重复冻结且旧陈旧timer失效；在途取消拒绝且零业务写",
  { timeout: 120_000 },
  async () => {
    const p = await db.prisma(),
      f = (active = await adFixture(p, {
        databaseUrl: await db.url(),
        redisUrl: process.env.REDIS_URL!,
        redisKeyPrefix: redis.prefix,
      }));
    // Upstream qualification history input only; this test exercises the real ad producer/capture boundary.
    await p.store.update({
      where: { id: f.merchant.store.id },
      data: { qualificationStatus: "pending" },
    });
    const pending = await f.runtime.ads.create(f.actor, f.createBody),
      ad = await p.ad.findUniqueOrThrow({ where: { id: pending.adId } });
    expect(pending.waitingReason).toBe("qualification");
    expect((await p.pointHold.findUniqueOrThrow({ where: { id: ad.pointHoldId } })).status).toBe(
      "held",
    );
    await expect(
      f.runtime.tx.run((tx) =>
        f.runtime.ads.production.assignTx(tx, f.adminActor, pending.adId, f.editorId),
      ),
    ).rejects.toMatchObject({ error: "AD_WAITING_QUALIFICATION" });
    expect(
      (await p.pointHold.findUniqueOrThrow({ where: { id: ad.pointHoldId } })).capturedAt,
    ).toBeNull();
    await f.runtime.tx.run((tx) =>
      f.runtime.ads.production.returnTx(tx, f.adminActor, pending.adId, "请补充清晰广告素材"),
    );
    const old = await p.timer.findFirstOrThrow({
        where: { kind: "ad.returned_stale", subjectId: pending.adId },
      }),
      holds = await p.pointHold.count({ where: { refType: "ad", refId: pending.adId } });
    const handler = f.runtime.assembly.timerHandler("ad.returned_stale")!;
    f.clock.set(old.fireAt);
    const timerInput = {
      id: old.id,
      kind: old.kind,
      subjectType: old.subjectType,
      subjectId: old.subjectId,
      payload: old.payload as Record<string, unknown>,
    };
    expect(await f.runtime.tx.run((tx) => handler.handle(tx, timerInput))).toBe("fired");
    expect(
      await p.outboxEvent.count({
        where: { eventType: "ad.returned_stale", aggregateId: pending.adId },
      }),
    ).toBe(1);
    expect(await f.runtime.tx.run((tx) => handler.handle(tx, timerInput))).toBe("fired");
    expect(
      await p.outboxEvent.count({
        where: { eventType: "ad.returned_stale", aggregateId: pending.adId },
      }),
    ).toBe(1);
    expect((await p.pointHold.findUniqueOrThrow({ where: { id: ad.pointHoldId } })).status).toBe(
      "held",
    );
    await f.runtime.ads.submit(f.actor, pending.adId, {});
    expect(await p.pointHold.count({ where: { refType: "ad", refId: pending.adId } })).toBe(holds);
    expect((await p.ad.findUniqueOrThrow({ where: { id: pending.adId } })).resubmitCount).toBe(1);
    expect(
      await f.runtime.tx.run((tx) =>
        handler.handle(tx, {
          id: old.id,
          kind: old.kind,
          subjectType: old.subjectType,
          subjectId: old.subjectId,
          payload: old.payload as Record<string, unknown>,
        }),
      ),
    ).toBe("skipped");
    await p.store.update({
      where: { id: f.merchant.store.id },
      data: { qualificationStatus: "verified" },
    });
    const quote = await f.runtime.adCancelRequests.quote(f.adminActor, f.created.adId, {
      reasonCode: "merchant_request",
    });
    await f.runtime.adCancelRequests.create(f.adminActor, f.created.adId, {
      reasonCode: "merchant_request",
      note: "商户请求取消制作中的广告",
      expect: quote.expect,
    });
    const tables = [
        "ad",
        "ad_revision",
        "point_hold",
        "point_ledger_entry",
        "ledger_operation",
        "audit_log",
        "outbox_event",
        "timer",
      ],
      before = await snapshotTables(p, tables);
    await expect(
      f.runtime.ads.requestChange(f.actor, f.created.adId, {
        versionNo: 1,
        note: "取消中仍试图修改",
      }),
    ).rejects.toMatchObject({ error: "AD_CANCEL_IN_PROGRESS" });
    expect(await snapshotTables(p, tables)).toEqual(before);
  },
);
