import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlanContentInput } from "@liyoxi/contract";
import { PlanContentSchema } from "@liyoxi/contract";
import { createIdentityContext, createIdempotencyContext, uuidv7 } from "../kernel/index.js";
import { sampleStaffContext, useSeededDatabase } from "../testing/index.js";
import { draft, harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
let adSequence = 7000;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
afterAll(() => h?.unbind());
async function ownOrder() {
  const o = await h.order(true),
    row = await h.make.staff({ staffRoleKey: "delivery_manager", isLead: false });
  await h.prisma.store.update({ where: { id: o.store.id }, data: { deliveryManagerId: row.id } });
  const staff = await sampleStaffContext(h.prisma, row.id),
    ctx = createIdentityContext({ actor: { type: "staff", id: row.id, client: "admin" } });
  expect(staff.dataScope).toBe("own");
  return { o, staff, ctx };
}
async function references(o: Awaited<ReturnType<Harness["order"]>>, storeId = o.store.id) {
  const now = h.clock.now(),
    id = uuidv7(),
    hold = await h.make.pointHold({
      entityId: o.entity.id,
      storeId,
      subscriptionTermId: o.order.subscriptionTermId,
      purpose: "ad",
      refType: "ad",
      refId: id,
    }),
    consent = await h.make.agreementConsent({
      scene: "ad_request",
      merchantUserId: o.user.id,
      entityId: o.entity.id,
      storeId,
      bizId: id,
    });
  const ad = await h.prisma.ad.create({
      data: {
        id,
        adNo: `GG20260106${adSequence++}`,
        entityId: o.entity.id,
        storeId,
        requestedByUserId: o.user.id,
        type: "opening",
        durationSec: 3,
        promoPointCodes: ["TEST"],
        copy: `广告-${id}`,
        status: "pending_assign",
        unitPricePoints: 100,
        discountBp: 10000,
        chargePoints: 100,
        pricingSnapshot: {},
        pointHoldId: hold.id,
        freeRevisionQuota: 2,
        agreementConsentId: consent.id,
        submittedAt: now,
        firstDueAt: now,
        createdAt: now,
        updatedAt: now,
      },
    }),
    asset = await h.prisma.storeAsset.create({
      data: {
        id: uuidv7(),
        entityId: o.entity.id,
        storeId,
        type: "text",
        title: `素材-${id}`,
        textBody: "虚构的范围测试素材",
        uploadActorType: "merchant",
        uploadActorId: o.user.id,
        uploadClient: "weapp",
        uploadActorRole: "owner",
        processingState: "pending",
        reviewState: "unreviewed",
        idempotencyKey: uuidv7(),
        createdAt: now,
        updatedAt: now,
      },
    }),
    account =
      storeId === o.store.id
        ? await h.prisma.channelAccount.update({
            where: { id: o.account.id },
            data: { accountName: `账号-${id}` },
          })
        : await h.prisma.channelAccount.create({
            data: {
              ...o.account,
              id: uuidv7(),
              storeId,
              accountName: `别店账号-${id}`,
              accountUid: id,
              accountUidNorm: id,
            },
          });
  return { ad, asset, account };
}
describe("方案引用不能越过父方案归属", { timeout: 60000 }, () => {
  it("own 员工对外主体、同主体外店、不存在的三类引用均收到同一 NOT_FOUND，草稿不落库", async () => {
    const { o, staff, ctx } = await ownOrder(),
      foreign = await h.order(true),
      sibling = await h.make.store({ entityId: o.entity.id }),
      outside = [await references(foreign), await references(o, sibling.id)];
    await expect(h.delivery.adminPlan(staff, foreign.deliveryPlanId)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    for (const refs of [
      ...outside,
      { account: { id: uuidv7() }, ad: { id: uuidv7() }, asset: { id: uuidv7() } },
    ]) {
      for (const kind of ["account", "ad", "asset"] as const) {
        const content: PlanContentInput = draft(o);
        if (kind === "account") content.items[0]!.channelAccountIds = [refs.account.id];
        if (kind === "ad") content.items[0]!.placements = [{ slot: "opening", adId: refs.ad.id }];
        if (kind === "asset") content.referenceAssetIds = [refs.asset.id];
        await expect(
          h.delivery.replaceDraft(ctx, staff, o.deliveryPlanId, { draftLockVersion: 0, content }),
        ).rejects.toMatchObject({ error: "NOT_FOUND" });
      }
    }
    expect(
      (await h.prisma.deliveryPlan.findUniqueOrThrow({ where: { id: o.deliveryPlanId } }))
        .draftLockVersion,
    ).toBe(0);
    expect(await h.prisma.auditLog.count({ where: { targetId: o.deliveryPlanId } })).toBe(0);
  });
  it("本店引用允许分步保存，账号未可用/日期不合规/素材不可用仍由推送拒绝", async () => {
    const { o, staff, ctx } = await ownOrder(),
      refs = await references(o),
      content: PlanContentInput = draft(o);
    await h.prisma.channelAccount.update({
      where: { id: refs.account.id },
      data: { status: "pending_verify" },
    });
    await h.prisma.storeAsset.update({
      where: { id: refs.asset.id },
      data: {
        reviewState: "reviewed",
        usability: "need_reshoot",
        reviewedByStaffId: staff.staff.id,
        reviewedAt: h.clock.now(),
      },
    });
    content.referenceAssetIds = [refs.asset.id];
    content.items[0]!.placements = [{ slot: "opening", adId: refs.ad.id }];
    content.items[0]!.agreedLaunchDate = null;
    const result = await h.delivery.replaceDraft(ctx, staff, o.deliveryPlanId, {
      draftLockVersion: 0,
      content,
    });
    expect(result.draft.referenceAssets[0]?.title).toBe(refs.asset.title);
    expect(result.draft.items[0]?.accounts[0]?.status).toBe("pending_verify");
    expect(result.draft.items[0]?.placements[0]?.copy).toBe(refs.ad.copy);
    await expect(
      h.delivery.push(ctx, staff, o.deliveryPlanId, { draftLockVersion: 1 }),
    ).rejects.toMatchObject({
      error: "PLAN_CONTENT_INVALID",
      details: {
        issues: expect.arrayContaining([
          { orderItemId: o.items[0]!.id, field: "accounts", reason: "account_invalid" },
          { orderItemId: null, field: "referenceAssets", reason: "reference_unusable" },
        ]),
      },
    });
  });
  it("既存外主体/外店草稿与版本污染在 GET、有效保存响应和幂等回放中均不展开", async () => {
    const { o, staff, ctx } = await ownOrder(),
      foreign = await h.order(true),
      sibling = await h.make.store({ entityId: o.entity.id }),
      owned = await references(o),
      outside = [await references(foreign), await references(o, sibling.id)];
    const safe: PlanContentInput = draft(o);
    safe.referenceAssetIds = [owned.asset.id];
    safe.items[0]!.placements = [{ slot: "opening", adId: owned.ad.id }];
    await h.delivery.replaceDraft(ctx, staff, o.deliveryPlanId, {
      draftLockVersion: 0,
      content: safe,
    });
    await h.delivery.push(ctx, staff, o.deliveryPlanId, { draftLockVersion: 1 });
    const plan = await h.prisma.deliveryPlan.findUniqueOrThrow({ where: { id: o.deliveryPlanId } }),
      polluted = PlanContentSchema.parse(plan.draft);
    polluted.referenceAssetIds.push(...outside.map((r) => r.asset.id));
    polluted.items[0]!.accounts.push(
      ...outside.map((r) => ({ channelAccountId: r.account.id, platform: "douyin" as const })),
    );
    polluted.items[0]!.placements.push(
      ...outside.map((r) => ({ slot: "ending" as const, adId: r.ad.id, durationSec: 3 })),
    );
    await h.prisma.deliveryPlan.update({
      where: { id: o.deliveryPlanId },
      data: { draft: polluted, currentVersionNo: 2 },
    });
    const previous = await h.prisma.deliveryPlanVersion.findFirstOrThrow({
      where: { deliveryPlanId: o.deliveryPlanId, versionNo: 1 },
    });
    await h.prisma.deliveryPlanVersion.updateMany({
      where: { id: previous.id },
      data: {
        decision: "superseded",
        decidedAt: h.clock.now(),
        decideActorType: "system",
        decideActorId: null,
        decideClient: null,
      },
    });
    // 模拟旧版本曾保存不正确引用；快照在 INSERT 时给定，保留不可变触发器。
    await h.prisma.deliveryPlanVersion.create({
      data: { ...previous, id: uuidv7(), versionNo: 2, contentSnapshot: polluted },
    });
    const assertSafe = (value: unknown) => {
      const text = JSON.stringify(value);
      for (const refs of outside)
        for (const forbidden of [
          refs.account.id,
          refs.account.accountName,
          refs.account.accountUid,
          refs.ad.id,
          refs.ad.copy,
          refs.ad.adNo,
          refs.asset.id,
          refs.asset.title,
        ])
          expect(text).not.toContain(forbidden!);
    };
    const get = await h.delivery.adminPlan(staff, o.deliveryPlanId);
    assertSafe(get);
    expect(get.draft.items[0]?.accounts.map((r) => r.channelAccountId)).toEqual([o.account.id]);
    expect(get.versions[0]?.content.referenceAssets.map((r) => r.storeAssetId)).toEqual([
      owned.asset.id,
    ]);
    assertSafe(await h.delivery.merchantPlan(o.viewer, o.deliveryPlanId));
    const key = uuidv7(),
      body = { draftLockVersion: 1, content: safe },
      idem = () =>
        createIdempotencyContext({
          mode: "required",
          scope: "admin.deliveryPlan.draft.replace",
          actor: ctx.actor,
          key,
          request: { method: "PUT", body },
        });
    const first = await h.delivery.replaceDraft(ctx, staff, o.deliveryPlanId, body, {
        idem: idem(),
      }),
      replay = idem(),
      second = await h.delivery.replaceDraft(ctx, staff, o.deliveryPlanId, body, { idem: replay });
    expect(replay.replayed).toBe(true);
    assertSafe(first);
    assertSafe(second);
    const cached = await h.prisma.idempotencyRecord.findFirstOrThrow({
      where: { key, scope: "admin.deliveryPlan.draft.replace" },
    });
    assertSafe(cached.result);
    expect(
      (await h.prisma.deliveryPlan.findUniqueOrThrow({ where: { id: o.deliveryPlanId } }))
        .draftLockVersion,
    ).toBe(2);
  });
});
