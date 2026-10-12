import { createPrismaClient } from "@liyoxi/db";
import type { Prisma } from "@liyoxi/db";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  createTenant,
  createFlow,
  readTenantAdminBillingFacts,
  readEntityStoreProfileFacts,
  countOrderItemsByPhase,
  media,
} from "../index.js";
import type { TenantAdminReadDeps, TxRunner } from "../index.js";
import { merchantFactsPort } from "../kernel/index.js";
import {
  assembleForTest,
  createLedgerHarness,
  openTerm,
  topUp,
  sampleStaffContext,
  snapshotTables,
  useSeededDatabase,
} from "../testing/index.js";
import type { LedgerHarness, FactoryDb } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";

const db = useSeededDatabase("services", { max: 1 });
const SLOW = 120_000;
let h: LedgerHarness;
const assembly = assembleForTest({ entry: "api" });
beforeAll(async () => {
  h = createLedgerHarness(await db.prisma());
}, SLOW);
afterEach(() => vi.restoreAllMocks());
const TABLES = [
  "entity",
  "store",
  "entity_member",
  "store_member",
  "store_profile",
  "qualification_submission",
  "approval_request",
  "store_asset",
  "billing_account",
  "subscription_term",
  "grant_schedule",
  "point_lot",
  "point_ledger_entry",
  "audit_log",
  "outbox_event",
  "status_transition",
  "timer",
];
const real: TenantAdminReadDeps = {
  billing: readTenantAdminBillingFacts,
  profiles: readEntityStoreProfileFacts,
  assets: media.readEntityAssetCounts,
  orders: countOrderItemsByPhase,
};
function service(runner = h.tx, adminRead = real, useAssembly = assembly) {
  return createTenant({
    tx: runner,
    clock: h.clock,
    events: h.events,
    assembly: useAssembly,
    flow: createFlow({ assembly: useAssembly, clock: h.clock, events: h.events }),
    adminRead,
  });
}
async function world() {
  const w = await h.make.merchant({ verified: true });
  const admin = await h.make.staff({ staffRoleKey: "super_admin" });
  const staff = await sampleStaffContext(h.prisma, admin.id);
  const second = await h.make.store({ entityId: w.entity.id });
  return { ...w, staff, second };
}
type World = Awaited<ReturnType<typeof world>>;
// 合法少量历史素材，只验证统计接线；不冒称本测试执行上传/采用/复制producer。
function asset(
  w: World,
  extra: Partial<Prisma.StoreAssetCreateManyInput> = {},
  tx: FactoryDb = h.prisma,
) {
  const now = h.clock.now();
  return tx.storeAsset.create({
    data: {
      id: uuidv7(),
      entityId: w.entity.id,
      storeId: w.store.id,
      type: "text",
      textBody: "后台读口虚构素材",
      uploadActorType: "merchant",
      uploadActorId: w.user.id,
      uploadActorRole: "owner",
      uploadClient: "weapp",
      processingState: "pending",
      reviewState: "unreviewed",
      adoptedCount: 0,
      idempotencyKey: uuidv7(),
      createdAt: now,
      updatedAt: now,
      ...extra,
    },
  });
}

describe("后台主体GET：真实拥有者组合", { timeout: SLOW }, () => {
  it("真实账本可用积分/周期/额度，同一个clock；不推进账户和grant", async () => {
    const w = await world();
    const { term } = await openTerm(h, { entityId: w.entity.id, months: 1 });
    await topUp(h, { entityId: w.entity.id, points: 123 });
    await h.prisma.billingAccount.update({
      where: { entityId: w.entity.id },
      data: { planAvailableQty: 999999 },
    });
    const before = await snapshotTables(h.prisma, TABLES);
    const clock = vi.spyOn(h.clock, "now");
    const card = await service().adminEntityGet(w.staff, w.entity.id);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(card.subscription).toMatchObject({
      status: "active",
      hasScheduledTerm: false,
      latestPaymentOrder: null,
      plan: { planId: term.planId },
    });
    expect(card.spendablePoints).toBeGreaterThanOrEqual(123);
    expect(card.spendablePoints).not.toBe(999999);
    expect(card.usage).toMatchObject({
      storesUsed: 2,
      storeLimit: term.maxStores,
      memberLimit: term.maxMembers,
      limitReason: "plan",
    });
    expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
  });

  it("真实档案地址和复制来源仅概要；缺档兄弟店nullable完整，无文件签名", async () => {
    const w = await world(),
      now = h.clock.now();
    await h.prisma.storeProfile.create({
      data: {
        storeId: w.store.id,
        entityId: w.entity.id,
        addressDetail: "虚构门店路一号",
        copiedFromStoreId: w.second.id,
        copyOptions: ["basic"],
        createdAt: now,
        updatedAt: now,
        contactName: "不得返回的联系人",
      },
    });
    const before = await snapshotTables(h.prisma, TABLES);
    const card = await service().adminEntityGet(w.staff, w.entity.id);
    expect(card.stores[0]).toMatchObject({
      address: { city: null, district: null, detail: "虚构门店路一号" },
      copiedFromStoreId: w.second.id,
    });
    expect(card.stores[1]).toMatchObject({
      lastDecidedAt: null,
      reviewDueAt: null,
      openQualificationSubmissionId: null,
      address: { city: null, district: null, detail: null },
      copiedFromStoreId: null,
    });
    expect(JSON.stringify(card)).not.toContain("不得返回的联系人");
    expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
  });

  it("真实开放资质轮次映射审批期限，已决定轮次仅提供最近决定时间", async () => {
    const w = await world(),
      now = h.clock.now();
    const dueAt = new Date(now.getTime() + 60_000);
    const round = await h.tx.run(async (tx) => {
      const approval = await tx.approvalRequest.create({
        data: {
          id: uuidv7(),
          kind: "qualification",
          category: "review",
          subjectType: "store",
          subjectId: w.store.id,
          entityId: w.entity.id,
          storeId: w.store.id,
          roundNo: 1,
          status: "pending",
          summarySnapshot: { title: "合法历史资质摘要" },
          submitActorType: "merchant",
          submitActorId: w.user.id,
          submitClient: "weapp",
          submittedAt: now,
          dueAt,
          slaSnapshot: { minutes: 1 },
          dedupeKey: `qualification:${w.store.id}`,
          createdAt: now,
          updatedAt: now,
        },
      });
      return tx.qualificationSubmission.create({
        data: {
          id: uuidv7(),
          entityId: w.entity.id,
          storeId: w.store.id,
          kind: "initial",
          roundNo: 1,
          claimedEntityType: "enterprise",
          proposedStoreName: "历史门店",
          proposedIndustryCode: "C900",
          proposedCategoryCode: "C901",
          proposedAddressSnapshot: { detail: "历史地址" },
          changedFields: [],
          declarationConfirmedAt: now,
          declarationVersion: "1",
          approvalRequestId: approval.id,
          submittedAt: now,
          submittedByUserId: w.user.id,
          createdByUserId: w.user.id,
          createdAt: now,
          updatedAt: now,
        },
      });
    });
    const before = await snapshotTables(h.prisma, TABLES);
    const card = await service().adminEntityGet(w.staff, w.entity.id);
    expect(card.stores[0]).toMatchObject({
      openQualificationSubmissionId: round.id,
      reviewDueAt: dueAt.toISOString(),
      lastDecidedAt: null,
    });
    expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
    await h.tx.run(async (tx) => {
      await tx.approvalRequest.update({
        where: { id: round.approvalRequestId! },
        data: { status: "withdrawn", decidedAt: now },
      });
      await tx.qualificationSubmission.update({
        where: { id: round.id },
        data: { closedAt: now, outcome: "withdrawn" },
      });
      await tx.storeProfile.create({
        data: {
          storeId: w.store.id,
          entityId: w.entity.id,
          lastDecidedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
    });
    expect((await service().adminEntityGet(w.staff, w.entity.id)).stores[0]).toMatchObject({
      openQualificationSubmissionId: null,
      reviewDueAt: null,
      lastDecidedAt: now.toISOString(),
    });
  });

  it("真实订阅不限成员仍用唯一额度公式，到期读不推进原周期", async () => {
    const w = await world();
    const { term } = await openTerm(h, { entityId: w.entity.id, planCode: "pro" });
    // openTerm的通用账本前提只填kind；在首次被测GET前补齐来源付款单的真实套餐快照。
    await h.prisma.billingOrder.update({
      where: { id: term.sourceBillingOrderId },
      data: {
        contentSnapshot: {
          v: 1,
          kind: "plan",
          planId: term.planId,
          planRevisionId: term.initialPlanRevisionId,
          months: term.months,
          cyclePriceFen: term.priceTotalFen,
          payFen: term.priceTotalFen,
          monthlyPoints: term.monthlyPoints,
          discountBp: term.discountBp,
          promo: null,
          quotedAt: term.createdAt.toISOString(),
        },
      },
    });
    await h.prisma.subscriptionTerm.update({ where: { id: term.id }, data: { maxMembers: null } });
    const active = await service().adminEntityGet(w.staff, w.entity.id);
    expect(active.usage).toMatchObject({ memberLimit: null, seatsOver: 0, limitReason: "plan" });
    const before = await snapshotTables(h.prisma, TABLES),
      previous = h.clock.now();
    try {
      h.clock.set(new Date(term.endsAt.getTime() + 1));
      const card = await service().adminEntityGet(w.staff, w.entity.id);
      expect(card.subscription.status).toBe("expired");
      expect(card.usage.limitReason).toBe("inactive");
      expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
    } finally {
      h.clock.set(previous);
    }
  });

  it("真实门店和全主体成员素材计数，不按当前店筛选/复核状态/采用次数膨胀", async () => {
    const w = await world(),
      reviewer = await h.make.staff();
    const source = await asset(w);
    await asset(w, {
      reviewState: "reviewed",
      reviewedAt: h.clock.now(),
      reviewedByStaffId: reviewer.id,
      usability: "ready",
      adoptedCount: 7,
      sourceStoreAssetId: source.id,
    });
    await asset(w, { storeId: w.second.id, adoptedCount: 2 });
    await asset(w, {
      uploadActorType: "staff",
      uploadActorId: reviewer.id,
      uploadActorRole: null,
      uploadClient: "admin",
    });
    await asset(w, { deletedAt: h.clock.now() });
    const card = await service().adminEntityGet(w.staff, w.entity.id);
    expect(
      card.stores.map((s) => [s.assetCount, s.reviewedAssetCount, s.copiedAssetCount]),
    ).toEqual([
      [3, 1, 1],
      [1, 0, 0],
    ]);
    const members = await service().adminEntityMemberList(w.staff, w.entity.id, {
      includeRemoved: true,
      storeId: w.second.id,
    });
    expect(members.items[0]).toMatchObject({
      memberId: w.owner.id,
      uploadedAssetCount: 3,
      adoptedAssetCount: 2,
      storeIds: [],
    });
  });

  it("实际订单phase pending_start计入producing，逐店查询不误用delivering", async () => {
    const w = await world();
    await openTerm(h, { entityId: w.entity.id });
    for (const phase of ["pending_start", "producing", "to_launch", "live"] as const) {
      const order = await h.make.dramaOrder({
        entityId: w.entity.id,
        storeId: w.store.id,
        status: phase,
      });
      await h.make.orderItem({ dramaOrderId: order.id, phase });
    }
    const card = await service().adminEntityGet(w.staff, w.entity.id);
    expect(card.stores[0]).toMatchObject({ liveDramaCount: 1, producingDramaCount: 3 });
    expect(card.stores[1]).toMatchObject({ liveDramaCount: 0, producingDramaCount: 0 });
  });

  it("已移除成员全店历史素材仍在，账号与成员当前状态分别映射", async () => {
    const w = await world(),
      user = await h.make.merchantUser();
    const member = await h.make.entityMember({
      entityId: w.entity.id,
      merchantUserId: user.id,
      role: "clerk",
      status: "removed",
      removedAt: h.clock.now(),
      removeReason: "self",
      removeActorType: "merchant",
      removeActorId: user.id,
      removeClient: "weapp",
    });
    await asset(w, {
      storeId: w.second.id,
      uploadActorId: user.id,
      uploadActorRole: "clerk",
      adoptedCount: 4,
    });
    expect(
      (await service().adminEntityMemberList(w.staff, w.entity.id, { includeRemoved: false }))
        .items,
    ).toHaveLength(1);
    const historical = (
      await service().adminEntityMemberList(w.staff, w.entity.id, { includeRemoved: true })
    ).items[1];
    expect(historical).toMatchObject({
      memberId: member.id,
      status: "removed",
      user: { status: "active" },
      storeIds: [],
      uploadedAssetCount: 1,
      adoptedAssetCount: 1,
    });
  });

  it("caller Tx未提交档案/素材/额度立即可见，真实外层rollback后所有事实复原", async () => {
    const w = await world(),
      before = await snapshotTables(h.prisma, TABLES);
    const outside = createPrismaClient({ connectionString: await db.url(), max: 1 });
    const external = createTenant({
      tx: createLedgerHarness(outside, { clock: h.clock }).tx,
      clock: h.clock,
      events: h.events,
      assembly,
      flow: createFlow({ assembly, clock: h.clock, events: h.events }),
      adminRead: real,
    });
    let enteredOutside!: () => void;
    let releaseOutside!: () => void;
    const outsideEntered = new Promise<void>((resolve) => {
      enteredOutside = resolve;
    });
    const outsideReleased = new Promise<void>((resolve) => {
      releaseOutside = resolve;
    });
    // 在caller事务进入ALS之前启动独立调用；只用真实barrier协调，不脱离祖先事务。
    const outsideRead = (async () => {
      enteredOutside();
      await outsideReleased;
      return external.adminEntityGet(w.staff, w.entity.id);
    })();
    try {
      await outsideEntered;
      await expect(
        h.tx.run(async (tx) => {
          await tx.entity.update({ where: { id: w.entity.id }, data: { storeLimitOverride: 7 } });
          await asset(w, {}, tx);
          await tx.storeProfile.create({
            data: {
              storeId: w.store.id,
              entityId: w.entity.id,
              addressDetail: "事务内地址",
              createdAt: h.clock.now(),
              updatedAt: h.clock.now(),
            },
          });
          const joined: TxRunner = { run: (fn) => fn(tx) };
          const card = await service(joined).adminEntityGet(w.staff, w.entity.id);
          const members = await service(joined).adminEntityMemberList(w.staff, w.entity.id, {
            includeRemoved: false,
          });
          expect(card).toMatchObject({
            usage: { storeLimit: 7 },
            stores: [
              { storeId: w.store.id, assetCount: 1, address: { detail: "事务内地址" } },
              expect.any(Object),
            ],
          });
          expect(members.items[0]?.uploadedAssetCount).toBe(1);
          releaseOutside();
          const other = await outsideRead;
          expect(other.usage.storeLimitOverride).toBeNull();
          expect(other.stores[0]).toMatchObject({ assetCount: 0, address: { detail: null } });
          throw new Error("真实外层故障");
        }),
      ).rejects.toThrow("真实外层故障");
      expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
      expect((await service().adminEntityGet(w.staff, w.entity.id)).stores[0]?.assetCount).toBe(0);
    } finally {
      releaseOutside();
      await outsideRead.catch(() => undefined);
      await outside.$disconnect();
    }
  });

  it("真实缺billing账户和缺merchant billing注册分别INTERNAL，不输出伪零", async () => {
    const w = await world();
    const missing = assembleForTest({ entry: "api", withoutRealPorts: [merchantFactsPort] });
    await expect(
      service(h.tx, real, missing).adminEntityGet(w.staff, w.entity.id),
    ).rejects.toMatchObject({ error: "INTERNAL" });
    const noAccount = await h.make.entity();
    await h.make.store({ entityId: noAccount.id });
    await expect(service().adminEntityGet(w.staff, noAccount.id)).rejects.toMatchObject({
      error: "INTERNAL",
    });
  });

  it("真实历史referral禁用后仍保归因，老板禁用仍返回真实账号状态", async () => {
    const user = await h.make.merchantUser();
    const now = h.clock.now(),
      admin = await h.make.staff({ staffRoleKey: "super_admin" });
    const code = await h.prisma.referralCode.create({
      data: {
        id: uuidv7(),
        code: `T${uuidv7().slice(-12).toUpperCase()}`,
        sourceType: "campaign",
        label: "原渠道",
        status: "disabled",
        disabledAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    const entity = await h.make.entity({
      createdByUserId: user.id,
      sourceType: "campaign",
      sourceReferralCodeId: code.id,
    });
    await h.make.store({ entityId: entity.id, isPrimary: true });
    const member = await h.make.entityMember({
      entityId: entity.id,
      merchantUserId: user.id,
      role: "owner",
      displayName: null,
    });
    await h.make.billingAccount({ entityId: entity.id });
    await h.prisma.merchantUser.update({ where: { id: user.id }, data: { status: "disabled" } });
    const card = await service().adminEntityGet(
      await sampleStaffContext(h.prisma, admin.id),
      entity.id,
    );
    expect(card.referralCode).toEqual({
      referralCodeId: code.id,
      code: code.code,
      label: "原渠道",
    });
    expect(card.owner).toMatchObject({
      merchantUserId: user.id,
      displayName: user.displayName,
      status: "disabled",
    });
    expect(member.displayName).toBeNull();
  });
});
