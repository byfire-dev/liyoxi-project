import { expect, it } from "vitest";
import {
  billingOrderContentSchema,
  StoreListQuerySchema,
  StoreListSummaryQuerySchema,
} from "@liyoxi/contract";
import {
  assembleForTest,
  createLedgerHarness,
  openTerm,
  sampleStaffContext,
  seedBillingDeletionFacts,
  snapshotTables,
  TEST_KEYRING,
  useSeededDatabase,
} from "../testing/index.js";
import type { Tx, TxRunOptions, TxRunner } from "../kernel/index.js";
import { uuidv7 } from "../kernel/index.js";
import { harness } from "./__fixtures__/harness.js";
import { createProfile } from "./service.js";

const db = useSeededDatabase("services", { max: 1, label: "sumlist" });
const query = (raw: unknown = {}) => StoreListQuerySchema.parse(raw);
const filter = (raw: unknown = {}) => StoreListSummaryQuerySchema.parse(raw);
const tables = [
  "store",
  "store_profile",
  "billing_account",
  "billing_order",
  "subscription_term",
  "point_lot",
  "audit_log",
  "outbox_event",
  "timer",
];
async function world() {
  const h = harness(await db.prisma());
  const staff = await sampleStaffContext(
    h.prisma,
    (await h.make.staff({ staffRoleKey: "super_admin" })).id,
  );
  return { h, staff };
}

it("完整本域筛选与来源、own/group/all同范围；F区域按zone、字典投影和summary/list同条件零写", async () => {
  const { h, staff } = await world();
  const referralId = uuidv7();
  const referral = await h.prisma.referralCode.create({
    data: {
      id: referralId,
      code: `SUM${referralId.slice(-12).toUpperCase()}`,
      sourceType: "sales",
      ownerStaffId: staff.staff.id,
      status: "active",
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  const attribution = {
    sourceType: referral.sourceType,
    sourceInviteCode: referral.code,
    sourceReferralCodeId: referral.id,
  };
  const user = await h.make.merchantUser(attribution);
  const entity = await h.make.entity({
    name: "测试主体甲",
    createdByUserId: user.id,
    ...attribution,
  });
  await h.make.billingAccount({ entityId: entity.id });
  const a = {
      entity,
      store: await h.make.store({ entityId: entity.id, isPrimary: true }),
    },
    b = await h.owner();
  const group = await h.prisma.staffGroup.findFirstOrThrow({
    where: { staffRoleKey: "delivery_manager", isDefault: true },
  });
  const manager = await h.make.staff({ staffRoleKey: "delivery_manager", staffGroupId: group.id }),
    peer = await h.make.staff({ staffRoleKey: "delivery_manager", staffGroupId: group.id }),
    lead = await h.make.staff({
      staffRoleKey: "delivery_manager",
      staffGroupId: group.id,
      isLead: true,
    });
  await h.prisma.store.update({
    where: { id: a.store.id },
    data: { name: "测试商家甲", deliveryManagerId: manager.id },
  });
  await h.prisma.store.update({
    where: { id: b.store.id },
    data: { name: "测试商家乙", deliveryManagerId: peer.id },
  });
  await h.prisma.storeProfile.create({
    data: {
      entityId: a.entity.id,
      storeId: a.store.id,
      provinceCode: "P_SUM",
      cityCode: "C_SUM",
      districtCode: "D_SUM",
      zoneCode: "F_SUM",
      industryCode: "I_SUM",
      categoryCode: "IC_SUM",
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  const sibling = await h.make.store({
    entityId: a.entity.id,
    isPrimary: false,
    name: "测试未分配",
  });
  const own = await sampleStaffContext(h.prisma, manager.id),
    broad = await sampleStaffContext(h.prisma, lead.id);
  const before = await snapshotTables(h.prisma, tables);
  const exact = {
    q: "主体甲",
    entityId: a.entity.id,
    sourceType: "sales",
    regionCode: "F_SUM",
    industryCode: "I_SUM",
    categoryCode: "IC_SUM",
    qualificationStatus: "unsubmitted",
    deliveryManagerId: manager.id,
  };
  const result = await h.profile.admin.list(own, query(exact));
  expect(result.total).toBe(1);
  expect(result.items[0]).toMatchObject({
    storeId: a.store.id,
    region: { zone: { code: "F_SUM", name: "F_SUM" } },
    industry: { code: "I_SUM", name: "I_SUM" },
    entity: { activeStoreCount: 2, primaryStoreName: "测试商家甲" },
  });
  expect((await h.profile.admin.summary(own, filter(exact))).total).toBe(result.total);
  for (const regionCode of ["P_SUM", "C_SUM", "D_SUM"])
    expect((await h.profile.admin.list(own, query({ ...exact, regionCode }))).total).toBe(1);
  expect((await h.profile.admin.list(own, query({ entityId: b.entity.id }))).total).toBe(0);
  expect(
    (await h.profile.admin.list(broad, query({ entityId: b.entity.id }))).items.map(
      (s) => s.storeId,
    ),
  ).toEqual([b.store.id]);
  expect(
    (
      await h.profile.admin.list(
        staff,
        query({ entityId: a.entity.id, isManagerUnassigned: "true" }),
      )
    ).items.map((s) => s.storeId),
  ).toEqual([sibling.id]);
  expect(
    (await h.profile.admin.list(staff, query({ entityId: a.entity.id, sourceType: "organic" })))
      .total,
  ).toBe(0);
  await h.prisma.staff.update({ where: { id: manager.id }, data: { status: "disabled" } });
  // 旧上下文的owner范围与角色模块不能沿缓存授权。
  await expect(h.profile.admin.list(own, query({ entityId: a.entity.id }))).rejects.toMatchObject({
    error: "PERMISSION_DENIED",
  });
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
});

it("跨北京日未推进周期现算、真实退款闸门和净实付店口径；页投影与既有detail钱包/付款标题一致", async () => {
  const { h, staff } = await world();
  h.clock.set(new Date("2026-10-31T15:59:59.000Z"));
  const plan = await h.prisma.plan.findFirstOrThrow({ orderBy: { rank: "asc" } }),
    revision = await h.prisma.planRevision.findFirstOrThrow({
      where: { planId: plan.id, cancelledAt: null },
      orderBy: { revisionNo: "desc" },
    }),
    pack = await h.prisma.pointPack.findFirstOrThrow();
  const planContent = (payFen: number) => ({
    v: 1,
    kind: "plan",
    planId: plan.id,
    planRevisionId: revision.id,
    months: 1,
    cyclePriceFen: payFen,
    payFen,
    monthlyPoints: revision.monthlyPoints,
    discountBp: revision.discountBp,
    promo: null,
    quotedAt: h.clock.now().toISOString(),
  });
  // 通用账本/关闭阻断夹具只造满足DB kind约束的最小订单；本组要对照真实detail，
  // 在任何读取与零写快照之前补全其全部历史付款内容，不改全局工厂或购买服务。
  const completeFixturePayments = async (entityId: string) => {
    const terms = await h.prisma.subscriptionTerm.findMany({ where: { entityId } });
    const byOrder = new Map(terms.map((t) => [t.sourceBillingOrderId, t]));
    const orders = await h.prisma.billingOrder.findMany({ where: { entityId } });
    for (const order of orders) {
      const kind = order.type === "topup" ? "topup" : "plan";
      const existing = billingOrderContentSchema.safeParse(order.contentSnapshot);
      if (existing.success && existing.data.kind === kind) continue;
      if (!["plan_new", "plan_renew", "topup"].includes(order.type))
        throw new Error(`本组夹具未定义付款类型：${order.type}`);
      const source = byOrder.get(order.id);
      const content = billingOrderContentSchema.parse(
        order.type === "topup"
          ? {
              v: 1,
              kind: "topup",
              packId: pack.id,
              points: pack.points,
              payFen: order.amountFen,
            }
          : {
              ...planContent(order.amountFen),
              ...(source
                ? {
                    planId: source.planId,
                    planRevisionId: source.initialPlanRevisionId,
                    months: source.months,
                    cyclePriceFen: source.priceTotalFen,
                    monthlyPoints: source.monthlyPoints,
                    discountBp: source.discountBp,
                  }
                : {}),
              quotedAt: order.createdAt.toISOString(),
            },
      );
      await h.prisma.billingOrder.update({
        where: { id: order.id },
        data: { contentSnapshot: content },
      });
    }
  };
  const scheduled = await h.owner();
  const order = await h.make.billingOrder({
    entityId: scheduled.entity.id,
    amountFen: revision.monthlyFeeFen,
    contentSnapshot: planContent(revision.monthlyFeeFen),
  });
  const term = await h.make.subscriptionTerm({
    entityId: scheduled.entity.id,
    planRevisionId: revision.id,
    sourceBillingOrderId: order.id,
    status: "scheduled",
    anchorDay: 1,
    startDate: new Date("2026-11-01T00:00:00Z"),
    endDate: new Date("2026-11-30T00:00:00Z"),
    startsAt: new Date("2026-10-31T16:00:00.000Z"),
    endsAt: new Date("2026-11-30T16:00:00.000Z"),
  });
  const cash = await h.owner(),
    sibling = await h.make.store({ entityId: cash.entity.id, isPrimary: false });
  await h.make.billingOrder({
    entityId: cash.entity.id,
    amountFen: 1000,
    refundedAmountFen: 200,
    contentSnapshot: planContent(1000),
  });
  await h.make.billingOrder({
    entityId: cash.entity.id,
    status: "refunded",
    amountFen: 500,
    contentSnapshot: planContent(500),
  });
  await h.make.billingOrder({
    entityId: cash.entity.id,
    type: "topup",
    status: "pending_payment",
    amountFen: pack.priceFen,
    contentSnapshot: {
      v: 1,
      kind: "topup",
      packId: pack.id,
      points: pack.points,
      payFen: pack.priceFen,
    },
  });
  const before = await snapshotTables(h.prisma, tables);
  expect(
    (
      await h.profile.admin.list(
        staff,
        query({ entityId: scheduled.entity.id, subscriptionStatus: "none" }),
      )
    ).total,
  ).toBe(1);
  h.clock.advance(1000);
  const active = await h.profile.admin.list(
    staff,
    query({
      entityId: scheduled.entity.id,
      subscriptionStatus: "active",
      planId: term.planId,
      expiresWithinDays: 30,
    }),
  );
  expect(active.total).toBe(1);
  expect(active.items[0]?.subscription).toMatchObject({ status: "active", hasScheduledTerm: true });
  expect(
    (
      await h.profile.admin.list(
        staff,
        query({ entityId: scheduled.entity.id, expiresWithinDays: 7 }),
      )
    ).total,
  ).toBe(0);
  expect(
    (await h.profile.admin.summary(staff, filter({ entityId: scheduled.entity.id })))
      .newThisMonthCount,
  ).toBe(0);
  const canonical = await h.profile.admin.get(staff, scheduled.store.id);
  expect(active.items[0]?.subscription).toEqual(canonical.subscription);
  expect(active.items[0]?.points).toEqual(canonical.points);
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  const cashList = await h.profile.admin.list(
    staff,
    query({ entityId: cash.entity.id, sort: "-totalPaidFen" }),
  );
  expect(cashList.items.map((r) => [r.storeId, r.totalPaidFen])).toEqual([
    [cash.store.id, 800],
    [sibling.id, null],
  ]);
  expect(await h.profile.admin.summary(staff, filter({ entityId: cash.entity.id }))).toMatchObject({
    total: 2,
    paidCount: 2,
    activePlanCount: 0,
  });
  const cashCanonical = await h.profile.admin.get(staff, cash.store.id);
  expect(cashList.items[0]?.subscription).toEqual(cashCanonical.subscription);
  expect(cashList.items[0]?.subscription.latestPaymentOrder?.title).toContain("加购积分");
  const refunded = await h.owner();
  await h.make.billingOrder({
    entityId: refunded.entity.id,
    status: "refunded",
    amountFen: 500,
    contentSnapshot: planContent(500),
  });
  expect(
    await h.profile.admin.summary(staff, filter({ entityId: refunded.entity.id })),
  ).toMatchObject({ total: 1, paidCount: 0, newThisMonthCount: 1 });
  // 非零钱包走真实账本发放；退款沿既有真实FK夹具，避免混入其固定历史期次编号。
  const funded = await h.owner(),
    ledger = createLedgerHarness(h.prisma, { clock: h.clock });
  await openTerm(ledger, { entityId: funded.entity.id });
  await completeFixturePayments(funded.entity.id);
  const fundedRow = (await h.profile.admin.list(staff, query({ entityId: funded.entity.id })))
    .items[0]!;
  const fundedOld = await h.profile.admin.get(staff, funded.store.id);
  expect(fundedRow.points.spendablePoints).toBeGreaterThan(0);
  expect(fundedRow.subscription).toEqual(fundedOld.subscription);
  expect(fundedRow.points).toEqual(fundedOld.points);
  const blocked = await h.owner();
  await h.tx.run((tx) =>
    seedBillingDeletionFacts(tx, h.clock, { entityId: blocked.entity.id, userId: blocked.user.id }),
  );
  await completeFixturePayments(blocked.entity.id);
  const refund = await h.prisma.refundRequest.findFirstOrThrow({
    where: { entityId: blocked.entity.id, status: "pending_approval" },
  });
  const blockedTerm = await h.prisma.subscriptionTerm.findFirstOrThrow({
    where: { entityId: blocked.entity.id, status: "scheduled" },
  });
  await h.prisma.subscriptionTerm.update({
    where: { id: blockedTerm.id },
    data: { refundRequestId: refund.id, refundRule: "window" },
  });
  h.clock.set(blockedTerm.startsAt);
  const frozen = await snapshotTables(h.prisma, tables);
  const row = (await h.profile.admin.list(staff, query({ entityId: blocked.entity.id }))).items[0]!;
  expect(row.subscription).toMatchObject({ status: "active", isRefundPending: true });
  expect(row.points.spendablePoints).toBe(0);
  const old = await h.profile.admin.get(staff, blocked.store.id);
  expect(row.subscription).toEqual(old.subscription);
  expect(row.points).toEqual(old.points);
  expect(await snapshotTables(h.prisma, tables)).toEqual(frozen);
  h.clock.set(new Date(term.endsAt.getTime() + 1));
  expect(
    (
      await h.profile.admin.list(
        staff,
        query({ entityId: scheduled.entity.id, subscriptionStatus: "expired" }),
      )
    ).total,
  ).toBe(1);
  expect(
    (
      await h.profile.admin.list(
        staff,
        query({ entityId: scheduled.entity.id, planId: term.planId }),
      )
    ).total,
  ).toBe(0);
});

it("默认/旧别名与nulls-last稳定分页，候选ID批量读调用上界不随店数增加；新旧projection同值且GET零写", async () => {
  const { h, staff } = await world(),
    own = await h.owner();
  const reads = new Map<string, number>();
  const traced: TxRunner = {
    run<T>(fn: (tx: Tx) => Promise<T>, options?: TxRunOptions) {
      return h.tx.run(
        (tx) =>
          fn(
            new Proxy(tx, {
              get(target, key, receiver) {
                const value = Reflect.get(target, key, receiver);
                if (typeof value === "function")
                  return (...args: unknown[]) => {
                    if (String(key).startsWith("$queryRaw"))
                      reads.set(String(key), (reads.get(String(key)) ?? 0) + 1);
                    return Reflect.apply(value, target, args);
                  };
                if (typeof value !== "object" || value === null || typeof key !== "string")
                  return value;
                return new Proxy(value, {
                  get(delegate, method) {
                    const call = Reflect.get(delegate, method);
                    if (typeof call !== "function") return call;
                    return (...args: unknown[]) => {
                      if (/^(find|count|aggregate|groupBy)/.test(String(method))) {
                        const name = `${key}.${String(method)}`;
                        reads.set(name, (reads.get(name) ?? 0) + 1);
                      }
                      return Reflect.apply(call, delegate, args);
                    };
                  },
                });
              },
            }),
          ),
        options,
      );
    },
  };
  const counted = createProfile({
    ...h,
    tx: traced,
    assembly: assembleForTest({ entry: "api" }),
    keyring: () => TEST_KEYRING,
    wechat: h.fake.wechat,
    currentOpenid: async () => "lyxtest_sumlist",
  });
  await counted.admin.list(staff, query({ entityId: own.entity.id }));
  const small = [...reads.values()].reduce((a, b) => a + b, 0);
  for (let i = 0; i < 4; i++)
    await h.make.store({
      entityId: own.entity.id,
      isPrimary: false,
      name: `测试同主体${i}`,
      createdAt: new Date(h.clock.now().getTime() - i - 1),
    });
  const child = await h.prisma.store.findFirstOrThrow({
    where: { entityId: own.entity.id, isPrimary: false },
  });
  const order = await h.make.dramaOrder({ entityId: own.entity.id, storeId: child.id });
  const before = await snapshotTables(h.prisma, tables);
  reads.clear();
  const all = await counted.admin.list(staff, query({ entityId: own.entity.id }));
  const large = [...reads.values()].reduce((a, b) => a + b, 0);
  expect(all.total).toBe(5);
  expect(large).toBeLessThanOrEqual(small + 1);
  expect(large).toBeLessThanOrEqual(16);
  expect(reads.get("subscriptionTerm.findMany")).toBe(1);
  expect(reads.get("billingOrder.groupBy")).toBe(1);
  expect(reads.get("dramaOrder.groupBy")).toBe(1);
  expect(all.items[0]?.storeId).toBe(child.id);
  expect(all.items[0]?.lastOrderAt).toBe(order.submittedAt.toISOString());
  const first = await h.profile.admin.list(staff, query({ entityId: own.entity.id, pageSize: 2 })),
    second = await h.profile.admin.list(
      staff,
      query({ entityId: own.entity.id, pageSize: 2, page: 2 }),
    );
  expect(first.items.map((r) => r.storeId)).toEqual(all.items.slice(0, 2).map((r) => r.storeId));
  expect(second.items.map((r) => r.storeId)).toEqual(all.items.slice(2, 4).map((r) => r.storeId));
  const created = await h.profile.admin.list(
    staff,
    query({ entityId: own.entity.id, sort: "-createdAt" }),
  );
  expect(
    (await h.profile.admin.list(staff, query({ entityId: own.entity.id, sort: "-registeredAt" })))
      .items,
  ).toEqual(created.items);
  expect(
    (
      await h.profile.admin.list(staff, query({ entityId: own.entity.id, sort: "registeredAt" }))
    ).items.map((r) => r.storeId),
  ).toEqual([...created.items].reverse().map((r) => r.storeId));
  const old = await h.profile.admin.get(staff, own.store.id),
    listed = all.items.find((r) => r.storeId === own.store.id)!;
  expect(listed.subscription).toEqual(old.subscription);
  expect(listed.points).toEqual(old.points);
  expect((await h.profile.admin.summary(staff, filter({ entityId: own.entity.id }))).total).toBe(
    all.total,
  );
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
});
