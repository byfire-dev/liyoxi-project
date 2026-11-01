import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createW508OrderAdFixture,
  snapshotTables,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";

const db = useSeededDatabase("services"),
  redis = useTestRedis(),
  cleanup: (() => Promise<unknown>)[] = [];
beforeEach(() => db.reset(), 120_000);
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await createW508OrderAdFixture(await db.prisma(), {
    databaseUrl: await db.url(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: redis.prefix,
  });
  cleanup.push(f.close);
  return f;
}
const money = [
  "billing_account",
  "point_lot",
  "point_hold",
  "point_hold_alloc",
  "ledger_operation",
  "point_ledger_entry",
];

describe("W5-08 实际订单广告引用与交付影响", { timeout: 120_000 }, () => {
  it("quote零写、未确认拒绝、浮动与钉版隔离；确认同TX推进，暂停跨完整重开轮次后恢复仍取代旧样片", async () => {
    const f = await fixture(),
      p = await db.prisma(),
      ad = await f.createAd(),
      r = f.runtime;
    const quoteInput = {
        dramaIds: [f.dramaId],
        channelAccountIds: [...f.accounts],
        isTopModel: false,
      },
      beforeQuote = await snapshotTables(p, [
        ...money,
        "order_item_placement",
        "outbox_event",
        "agreement_consent",
      ]),
      pending = await r.order.quote(f.actor, quoteInput);
    expect(pending.ads.some((value) => value.adId === ad.adId)).toBe(false);
    expect(
      await snapshotTables(p, [
        ...money,
        "order_item_placement",
        "outbox_event",
        "agreement_consent",
      ]),
    ).toEqual(beforeQuote);
    await expect(
      r.order.create(f.actor, {
        ...quoteInput,
        focusCodes: ["W115F"],
        adIds: [ad.adId],
        agreementVersionId: pending.agreement.agreementVersionId,
        expect: pending.expect,
      }),
    ).rejects.toMatchObject({
      error: "ORDER_AD_INVALID",
      details: { adId: ad.adId, reason: "not_confirmed" },
    });
    expect(
      await snapshotTables(p, [
        ...money,
        "order_item_placement",
        "outbox_event",
        "agreement_consent",
      ]),
    ).toEqual(beforeQuote);
    const v1 = await f.pushAd(ad.adId);
    await f.confirmAd(ad.adId, v1.versionNo);
    const ready = await r.order.quote(f.actor, quoteInput);
    expect(ready.ads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ adId: ad.adId, confirmedVersionNo: 1, type: "opening" }),
      ]),
    );
    const floating = await f.createBoundOrder(ad.adId),
      pinned = await f.createBoundOrder(ad.adId),
      paused = await f.createBoundOrder(ad.adId);
    const s1 = await f.pushSample(floating),
      s2 = await f.pushSample(pinned),
      s3 = await f.pushSample(paused);
    await f.delivery.sampleConfirm(f.actor, s2.sampleId, {
      versionNo: s2.versionNo,
      viewedVia: "weapp",
      hasViewed: true,
    });
    const cancellation = await f.pause(paused),
      pinnedBefore = await p.orderItemPlacement.findMany({ where: { orderItemId: pinned.itemId } });
    expect(pinnedBefore[0]).toMatchObject({ boundVersionNo: 1, pinnedAt: expect.any(Date) });
    expect((await f.placementDetails(ad.adId)).usage.inUseCount).toBe(3);
    expect((await f.references(ad.adId)).filter((ref) => ref.boundVersionNo === null)).toHaveLength(
      2,
    );
    await f.feedback(s1.sampleId, {
      versionNo: s1.versionNo,
      feedbackKind: "ad_content",
      adId: ad.adId,
      note: "真实广告重开验证浮动引用",
    });
    expect(await p.sample.findUniqueOrThrow({ where: { id: s1.sampleId } })).toMatchObject({
      status: "superseded",
    });
    expect(
      await p.deliveryTicket.findUniqueOrThrow({ where: { id: floating.ticketId } }),
    ).toMatchObject({ step: "ad_prep" });
    expect(await p.sample.findUniqueOrThrow({ where: { id: s3.sampleId } })).toMatchObject({
      status: "pushed",
    });
    expect(await p.orderItemPlacement.findMany({ where: { orderItemId: pinned.itemId } })).toEqual(
      pinnedBefore,
    );
    expect(await p.sample.findUniqueOrThrow({ where: { id: s2.sampleId } })).toMatchObject({
      status: "confirmed",
    });
    expect(
      (await r.order.quote(f.actor, quoteInput)).ads.some((value) => value.adId === ad.adId),
    ).toBe(true);
    const v2 = await f.pushAd(ad.adId);
    expect(v2.versionNo).toBe(2);
    expect(
      (await r.order.quote(f.actor, quoteInput)).ads.find((value) => value.adId === ad.adId),
    ).toMatchObject({ confirmedVersionNo: 1 });
    await f.confirmAd(ad.adId, v2.versionNo);
    // No sweep: confirmation's same transaction reevaluates floating ad_prep tickets.
    expect(
      await p.deliveryTicket.findUniqueOrThrow({ where: { id: floating.ticketId } }),
    ).toMatchObject({ step: "sample_making" });
    expect(await p.sample.findUniqueOrThrow({ where: { id: s3.sampleId } })).toMatchObject({
      status: "pushed",
    });
    await f.resume(cancellation.cancelRequestId);
    expect(await p.sample.findUniqueOrThrow({ where: { id: s3.sampleId } })).toMatchObject({
      status: "superseded",
    });
    expect(
      await p.deliveryTicket.findUniqueOrThrow({ where: { id: paused.ticketId } }),
    ).toMatchObject({ step: "sample_making", pauseCount: 0 });
    expect(await p.orderItemPlacement.findMany({ where: { orderItemId: pinned.itemId } })).toEqual(
      pinnedBefore,
    );
  });

  it("staff样片内容修改只消耗真实免费轮次，保存时间点；耗尽拒绝且零资金/版本/样片写", async () => {
    const f = await fixture(),
      p = await db.prisma(),
      ad = await f.createAd();
    const v1 = await f.pushAd(ad.adId);
    await f.confirmAd(ad.adId, v1.versionNo);
    const target = await f.createBoundOrder(ad.adId),
      quota = (await p.ad.findUniqueOrThrow({ where: { id: ad.adId } })).freeRevisionQuota;
    expect(quota).toBeGreaterThan(0);
    let sample = await f.pushSample(target);
    for (let round = 1; round <= quota; round++) {
      const before = await snapshotTables(p, money);
      const view = await f.feedback(sample.sampleId, {
        versionNo: sample.versionNo,
        feedbackKind: "ad_content",
        adId: ad.adId,
        note: `免费广告内容修改${round}`,
        feedbackTimeMs: 4567,
      });
      expect(view).toMatchObject({
        status: "superseded",
        decision: {
          feedbackKind: "ad_content",
          feedbackTimeMs: 4567,
          onBehalfBy: { staffId: f.admin.staff.staff.id },
        },
      });
      expect(await p.ad.findUniqueOrThrow({ where: { id: ad.adId } })).toMatchObject({
        status: "revising",
        revisionCount: round,
      });
      expect(
        await p.adRevision.findFirstOrThrow({ where: { adId: ad.adId, revisionNo: round } }),
      ).toMatchObject({
        source: "sample_feedback",
        actorType: "staff",
        client: "admin",
        isChargeable: false,
        chargePoints: 0,
      });
      expect(await snapshotTables(p, money)).toEqual(before);
      const version = await f.pushAd(ad.adId);
      await f.confirmAd(ad.adId, version.versionNo);
      sample = await f.pushSample(target);
    }
    const before = await snapshotTables(p, [
      ...money,
      "ad",
      "ad_revision",
      "ad_version",
      "sample",
      "delivery_ticket",
      "status_transition",
      "outbox_event",
    ]);
    await expect(
      f.feedback(sample.sampleId, {
        versionNo: sample.versionNo,
        feedbackKind: "ad_content",
        adId: ad.adId,
        note: "员工不能代老板付费",
        feedbackTimeMs: 9999,
      }),
    ).rejects.toMatchObject({ error: "AD_FREE_REVISION_EXHAUSTED" });
    expect(
      await snapshotTables(p, [
        ...money,
        "ad",
        "ad_revision",
        "ad_version",
        "sample",
        "delivery_ticket",
        "status_transition",
        "outbox_event",
      ]),
    ).toEqual(before);
  });
});
