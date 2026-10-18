import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimDeliveries, consumeDelivery } from "../events/index.js";
import { alertsOf, createIdentityContext, uuidv7 } from "../kernel/index.js";
import { createTenant } from "../tenant/index.js";
import { createFactories, snapshotTables, useSeededDatabase } from "../testing/index.js";
import { lifecycleWorld, DAY } from "./__fixtures__/profile-lifecycle.js";

const SLOW = 120_000;
const db = useSeededDatabase("services");
let h: ReturnType<typeof lifecycleWorld>;
beforeAll(async () => {
  h = lifecycleWorld(await db.prisma());
}, SLOW);
afterAll(() => h?.scope.close());

async function world(verified = true) {
  const own = await h.make.merchant({ verified });
  const second = await h.make.store({ entityId: own.entity.id });
  const ctx = createIdentityContext({
    actor: { type: "merchant", id: own.user.id, client: "weapp" },
    entityId: own.entity.id,
    storeId: own.store.id,
    requestId: `req_archive_${uuidv7()}`,
  });
  const tenant = createTenant({ ...h, archiveTimers: h.timers });
  return { ...own, ctx, second, tenant };
}

// 仅建立正式约束允许的历史业务事实；不代替广告/账号/资质提交入口验收。
async function qualification(store: { id: string; entityId: string }, userId: string) {
  const now = h.clock.now(),
    approvalId = uuidv7(),
    id = uuidv7();
  await h.prisma.approvalRequest.create({
    data: {
      id: approvalId,
      kind: "qualification",
      category: "review",
      subjectType: "store",
      subjectId: store.id,
      entityId: store.entityId,
      storeId: store.id,
      roundNo: 1,
      status: "pending",
      summarySnapshot: { title: "归档阻断前史" },
      submitActorType: "merchant",
      submitActorId: userId,
      submitClient: "weapp",
      submittedAt: now,
      dedupeKey: `qualification:${store.id}`,
      createdAt: now,
      updatedAt: now,
    },
  });
  await h.prisma.qualificationSubmission.create({
    data: {
      id,
      entityId: store.entityId,
      storeId: store.id,
      kind: "new_store",
      roundNo: 1,
      proposedStoreName: "阻断门店",
      proposedIndustryCode: "LCI",
      proposedCategoryCode: "LCC",
      proposedAddressSnapshot: { detail: "测试路" },
      changedFields: [],
      declarationConfirmedAt: now,
      declarationVersion: "1",
      approvalRequestId: approvalId,
      submittedAt: now,
      submittedByUserId: userId,
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    },
  });
}
async function ad(store: { id: string; entityId: string }, userId: string) {
  const id = uuidv7(),
    now = h.clock.now();
  const hold = await h.make.pointHold({
    entityId: store.entityId,
    storeId: store.id,
    purpose: "ad",
    refType: "ad",
    refId: id,
  });
  const consent = await h.make.agreementConsent({
    scene: "ad_request",
    merchantUserId: userId,
    entityId: store.entityId,
    storeId: store.id,
    bizId: id,
  });
  await h.prisma.ad.create({
    data: {
      id,
      adNo: `GG20261012${id.replaceAll("-", "").slice(-6)}`,
      entityId: store.entityId,
      storeId: store.id,
      requestedByUserId: userId,
      type: "opening",
      durationSec: 3,
      promoPointCodes: ["TEST"],
      status: "pending_assign",
      unitPricePoints: 100,
      discountBp: 10000,
      chargePoints: 100,
      pricingSnapshot: {},
      pointHoldId: hold.id,
      freeRevisionQuota: 2,
      latestVersionNo: 0,
      agreementConsentId: consent.id,
      submittedAt: now,
      firstDueAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
}
async function channel(store: { id: string; entityId: string }) {
  const id = uuidv7(),
    now = h.clock.now();
  await h.prisma.channelAccount.create({
    data: {
      id,
      entityId: store.entityId,
      storeId: store.id,
      platform: "douyin",
      accountName: "归档阻断前史",
      accountUid: id,
      accountUidNorm: id,
      status: "pending_verify",
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
}

describe("门店归档真实 owner 事实及 profile 消费", { timeout: SLOW }, () => {
  it.each([
    "open_order",
    "open_delivery_ticket",
    "ad_in_production",
    "qualification_in_review",
    "channel_account_in_review",
    "unverified_primary_store",
  ] as const)("%s 使用真实同事务拥有者计数拒绝，全部状态/审计/事件零写", async (kind) => {
    const w = await world(kind !== "unverified_primary_store");
    const target = kind === "unverified_primary_store" ? w.store : w.second;
    if (kind === "open_order") await h.make.dramaOrder({ storeId: target.id });
    if (kind === "open_delivery_ticket") {
      const order = await h.make.dramaOrder({ storeId: target.id, status: "producing" });
      const item = await h.make.orderItem({ dramaOrderId: order.id, phase: "producing" });
      await h.make.deliveryTicket({ orderItemId: item.id, step: "assigning" });
    }
    if (kind === "ad_in_production") await ad(target, w.user.id);
    if (kind === "qualification_in_review") await qualification(target, w.user.id);
    if (kind === "channel_account_in_review") await channel(target);
    const before = await snapshotTables(h.prisma, [
      "store",
      "entity_member",
      "store_member",
      "timer",
      "status_transition",
      "audit_log",
      "outbox_event",
      "drama_order",
      "delivery_ticket",
      "ad",
      "qualification_submission",
      "channel_account",
    ]);
    await expect(w.tenant.archiveStore(w.ctx, { storeId: target.id })).rejects.toMatchObject({
      error: "STORE_HAS_OPEN_WORK",
      details: { blockers: expect.arrayContaining([{ kind, count: 1 }]) },
    });
    expect(await snapshotTables(h.prisma, Object.keys(before))).toEqual(before);
  });

  it("五个真实业务阻断同时返回稳定次序，跨店事实不误挡空店", async () => {
    const w = await world();
    await ad(w.second, w.user.id);
    await qualification(w.second, w.user.id);
    await channel(w.second);
    const order = await h.make.dramaOrder({ storeId: w.second.id, status: "producing" });
    const item = await h.make.orderItem({ dramaOrderId: order.id, phase: "producing" });
    await h.make.deliveryTicket({ orderItemId: item.id });
    await expect(w.tenant.archiveStore(w.ctx, { storeId: w.second.id })).rejects.toMatchObject({
      details: {
        blockers: [
          { kind: "open_order", count: 1 },
          { kind: "open_delivery_ticket", count: 1 },
          { kind: "ad_in_production", count: 1 },
          { kind: "qualification_in_review", count: 1 },
          { kind: "channel_account_in_review", count: 1 },
        ],
      },
    });
    const third = await h.make.store({ entityId: w.entity.id });
    await expect(w.tenant.archiveStore(w.ctx, { storeId: third.id })).resolves.toMatchObject({
      store: { storeId: third.id, lifecycle: "archived" },
    });
  });

  it("同一外层事务的未提交 blocker 可见，失败不泄漏工单/订单/归档", async () => {
    const w = await world();
    await expect(
      h.tx.run(async (tx) => {
        const make = createFactories({ db: tx, clock: h.clock });
        await make.dramaOrder({ storeId: w.second.id });
        const nested = createTenant({ ...h, tx: { run: (fn) => fn(tx) }, archiveTimers: h.timers });
        await nested.archiveStore(w.ctx, { storeId: w.second.id });
      }),
    ).rejects.toMatchObject({ error: "STORE_HAS_OPEN_WORK" });
    expect(await h.prisma.dramaOrder.count({ where: { storeId: w.second.id } })).toBe(0);
    expect(await h.prisma.statusTransition.count({ where: { subjectId: w.second.id } })).toBe(0);
    expect((await h.prisma.store.findUniqueOrThrow({ where: { id: w.second.id } })).lifecycle).toBe(
      "active",
    );
  });

  it("真实 archive outbox 展开并消费原 profile subscriber；归档保留180天且重投零写", async () => {
    const o = await h.owner("new_store");
    const primary = await h.make.store({
      entityId: o.entity.id,
      isPrimary: true,
      qualificationStatus: "verified",
    });
    await h.make.entityMember({
      entityId: o.entity.id,
      merchantUserId: o.user.id,
      role: "owner",
      lastStoreId: primary.id,
    });
    const ctx = createIdentityContext({
      actor: o.ctx.actor,
      entityId: o.entity.id,
      storeId: primary.id,
    });
    const assets = await h.assets(o);
    const draft = await h.draft(o, "new_store");
    const tenant = createTenant({ ...h, archiveTimers: h.timers });
    const beforeRef = await Promise.all(assets.inputs.map((input) => h.readRef(input)));
    expect(beforeRef.every((r) => r?.state === "live")).toBe(true);
    await tenant.archiveStore(ctx, { storeId: o.store.id });
    const event = await h.prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: o.store.id, eventType: "store.archived" },
    });
    while ((await h.events.expand()).events > 0) {
      /* 原 outbox 展开，不伪造投递。 */
    }
    const { claimed } = await h.tx.run((tx) => claimDeliveries(tx));
    const ref = claimed.find(
      (r) => r.eventId === event.id && r.subscriber === "profile.onTenantLifecycle",
    );
    expect(ref).toBeDefined();
    const deps = {
      tx: h.tx,
      clock: h.clock,
      subscribers: h.events.subscribers,
      alerts: alertsOf(h.assembly),
    };
    expect(await consumeDelivery(deps, ref!)).toBe("done");
    for (const input of assets.inputs)
      expect(await h.readRef(input)).toEqual({
        state: "released",
        releasedAt: h.clock.now(),
        keepUntil: new Date(h.clock.now().getTime() + 180 * DAY),
      });
    expect(
      await h.prisma.qualificationSubmission.findUniqueOrThrow({ where: { id: draft.round.id } }),
    ).toMatchObject({ closedAt: h.clock.now(), outcome: "discarded", submittedAt: null });
    expect(
      await h.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: draft.doc.id } }),
    ).toMatchObject({ removedAt: h.clock.now() });
    expect(await h.readRef(draft.input)).toEqual({
      state: "released",
      releasedAt: h.clock.now(),
      keepUntil: new Date(h.clock.now().getTime() + 7 * DAY),
    });
    const before = await h.snapshot(o.entity.id);
    expect(await consumeDelivery(deps, ref!)).toBe("stale");
    expect(await h.snapshot(o.entity.id)).toEqual(before);
    expect(await h.prisma.storeProfileMedia.count({ where: { storeId: o.store.id } })).toBe(4);
    expect(await h.prisma.storeServiceItem.count({ where: { storeId: o.store.id } })).toBe(1);
  });
});
