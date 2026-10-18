import type { Prisma } from "@liyoxi/db";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "../../kernel/index.js";
import {
  createFactories,
  createLedgerHarness,
  openTerm,
  seedBillingDeletionFacts,
  snapshotTables,
  topUp,
  useSeededDatabase,
} from "../../testing/index.js";
import type { LedgerHarness } from "../../testing/index.js";
import { getWalletView, readTenantAdminBillingFacts } from "../index.js";

const db = useSeededDatabase("services", { max: 1 });
const SLOW = 120_000;
let h: LedgerHarness;
let plan: { id: string; code: string; name: string };
let revision: { id: string };
let bankId: string;
beforeAll(async () => {
  h = createLedgerHarness(await db.prisma());
  plan = await h.prisma.plan.findUniqueOrThrow({ where: { code: "pro" } });
  revision = await h.prisma.planRevision.findFirstOrThrow({ where: { planId: plan.id } });
  const world = await h.make.merchant();
  await h.tx.run((tx) =>
    seedBillingDeletionFacts(tx, h.clock, { entityId: world.entity.id, userId: world.user.id }),
  );
  bankId = (
    await h.prisma.financeConfigRevision.findFirstOrThrow({ where: { configKey: "bank_account" } })
  ).id;
}, SLOW);
beforeEach(() => h.clock.set(new Date("2026-10-10T04:00:00Z")));

const read = (entityId: string, now = h.clock.now()) =>
  h.tx.run((tx) => readTenantAdminBillingFacts(tx, { entityId, now }));
const TABLES = [
  "billing_account",
  "billing_order",
  "subscription_term",
  "point_lot",
  "grant_schedule",
  "ledger_operation",
  "point_ledger_entry",
  "status_transition",
  "audit_log",
  "outbox_event",
];
// 全部快照为合法历史事实，不宣称续费/升级/加购公开购买 producer 已完成。
function content(type: string): Prisma.InputJsonObject {
  if (type === "topup") return { v: 1, kind: "topup", packId: uuidv7(), points: 1234, payFen: 100 };
  if (type === "plan_upgrade")
    return {
      v: 1,
      kind: "upgrade",
      termId: uuidv7(),
      fromPlanRevisionId: revision.id,
      toPlanRevisionId: revision.id,
      quotedAt: h.clock.now().toISOString(),
      quotedOn: "2026-10-10",
      monthIndex: 0,
      remainingDays: 12,
      baseDays: 30,
      remainingFullMonths: 0,
      feeDeltaPerMonthFen: 100,
      pointsDeltaPerMonth: 1,
      proratedFen: 100,
      payFen: 100,
      topupPoints: 1,
      validUntil: "2026-10-10T05:00:00.000Z",
    };
  return {
    v: 1,
    kind: "plan",
    planId: plan.id,
    planName: "不采用旧名称",
    planRevisionId: revision.id,
    months: 3,
    cyclePriceFen: 100,
    payFen: 100,
    monthlyPoints: 1,
    discountBp: 9000,
    promo: null,
    quotedAt: h.clock.now().toISOString(),
  };
}

describe("后台主体计费摘要：真实调用方事务", () => {
  it(
    "不存在主体和存在但缺账户分别拒绝，不把缺事实当零",
    async () => {
      await expect(read(uuidv7())).rejects.toMatchObject({ error: "NOT_FOUND" });
      const entity = await h.make.entity();
      await expect(read(entity.id)).rejects.toMatchObject({ error: "INTERNAL" });
    },
    SLOW,
  );

  it(
    "真实从未开通无订单为完整空订阅，别主体订单不污染",
    async () => {
      const own = await h.make.merchant(),
        other = await h.make.merchant();
      await h.make.billingOrder({
        entityId: other.entity.id,
        contentSnapshot: content("plan_new"),
      });
      expect(await read(own.entity.id)).toEqual({
        subscription: {
          status: "none",
          plan: null,
          months: null,
          startDate: null,
          endDate: null,
          hasScheduledTerm: false,
          isRefundPending: false,
          latestPaymentOrder: null,
        },
        spendablePoints: 0,
      });
    },
    SLOW,
  );

  it.each(["plan_new", "plan_renew", "plan_upgrade", "topup"] as const)(
    "%s 按真实快照和当前套餐名渲染标题",
    async (type) => {
      const world = await h.make.merchant();
      const order = await h.make.billingOrder({
        entityId: world.entity.id,
        type,
        status: "cancelled",
        contentSnapshot: content(type),
      });
      const title =
        type === "topup"
          ? "加购积分 1,234"
          : type === "plan_upgrade"
            ? `升级${plan.name}（本期剩余 12 天）`
            : `${type === "plan_new" ? "开通" : "续费"}${plan.name} · 3 个月`;
      expect((await read(world.entity.id)).subscription.latestPaymentOrder).toEqual({
        paymentOrderId: order.id,
        orderNo: order.orderNo,
        type,
        status: "cancelled",
        title,
        refundedAt: null,
      });
    },
    SLOW,
  );

  it.each(["pending_payment", "pending_confirmation", "paid", "cancelled", "refunded"] as const)(
    "最近创建的 %s 付款单均展示，不按支付状态过滤",
    async (status) => {
      const world = await h.make.merchant();
      await h.make.billingOrder({
        entityId: world.entity.id,
        status: "cancelled",
        contentSnapshot: content("plan_new"),
      });
      h.clock.advance(1);
      const order = await h.make.billingOrder({
        entityId: world.entity.id,
        status,
        contentSnapshot: content("plan_new"),
        ...(status === "pending_confirmation"
          ? {
              channel: "bank_transfer",
              transferState: "proof_submitted",
              bankAccountFinanceConfigRevisionId: bankId,
            }
          : {}),
      });
      expect((await read(world.entity.id)).subscription.latestPaymentOrder).toEqual({
        paymentOrderId: order.id,
        orderNo: order.orderNo,
        type: "plan_new",
        status,
        title: `开通${plan.name} · 3 个月`,
        refundedAt: order.refundedAt?.toISOString() ?? null,
      });
    },
    SLOW,
  );

  it(
    "同创建时刻按ID倒序稳定选择，不使用支付时间",
    async () => {
      const world = await h.make.merchant();
      const ids: string[] = [];
      for (let i = 0; i < 2; i++)
        ids.push(
          (
            await h.make.billingOrder({
              entityId: world.entity.id,
              status: "cancelled",
              contentSnapshot: content("plan_new"),
            })
          ).id,
        );
      const expected = ids.sort().at(-1);
      expect((await read(world.entity.id)).subscription.latestPaymentOrder?.paymentOrderId).toBe(
        expected,
      );
    },
    SLOW,
  );

  it(
    "真实批次现算生效积分；到期边界不advance、不读账户缓存且保最近周期",
    async () => {
      const world = await h.make.merchant({ verified: true });
      const first = await openTerm(h, { entityId: world.entity.id });
      await topUp(h, { entityId: world.entity.id, points: 77 });
      h.clock.advance(1);
      await h.make.billingOrder({
        entityId: world.entity.id,
        status: "cancelled",
        contentSnapshot: content("plan_new"),
      });
      const before = await snapshotTables(h.prisma, TABLES);
      const active = await read(world.entity.id, new Date(first.term.endsAt.getTime() - 1));
      const expectedPlan = { planId: plan.id, code: plan.code, name: plan.name };
      expect(active.subscription).toMatchObject({
        status: "active",
        plan: expectedPlan,
        months: 1,
        latestPaymentOrder: null,
      });
      expect(active.spendablePoints).toBe(6677);
      const expired = await read(world.entity.id, first.term.endsAt);
      expect(expired.subscription).toMatchObject({
        status: "expired",
        plan: expectedPlan,
        months: 1,
        startDate: first.term.startDate.toISOString().slice(0, 10),
        endDate: first.term.endDate.toISOString().slice(0, 10),
      });
      expect(expired.spendablePoints).toBe(0);
      expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
    },
    SLOW,
  );

  it(
    "scheduled到点未推进仍hasScheduledTerm，钱包未来列表已空也不漏判",
    async () => {
      const world = await h.make.merchant({ verified: true });
      const first = await openTerm(h, { entityId: world.entity.id });
      const next = await openTerm(h, { entityId: world.entity.id, after: first.term });
      expect((await read(world.entity.id)).subscription.hasScheduledTerm).toBe(true);
      expect(
        (await h.tx.run((tx) => getWalletView(tx, world.entity.id, next.term.startsAt)))
          .subscription.scheduledTerms,
      ).toEqual([]);
      expect((await read(world.entity.id, next.term.startsAt)).subscription).toMatchObject({
        status: "active",
        hasScheduledTerm: true,
        latestPaymentOrder: null,
      });
      expect(
        (await h.prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: next.term.id } })).status,
      ).toBe("scheduled");
    },
    SLOW,
  );

  it(
    "预约周期真实退款引用也是主体级退款，不摘外键造标记",
    async () => {
      const world = await h.make.merchant();
      await h.tx.run((tx) =>
        seedBillingDeletionFacts(tx, h.clock, { entityId: world.entity.id, userId: world.user.id }),
      );
      const refund = await h.prisma.refundRequest.findFirstOrThrow({
        where: { entityId: world.entity.id, status: "pending_approval" },
      });
      const term = await h.prisma.subscriptionTerm.findFirstOrThrow({
        where: { entityId: world.entity.id, status: "scheduled" },
      });
      await h.prisma.subscriptionTerm.update({
        where: { id: term.id },
        data: { refundRequestId: refund.id, refundRule: "window" },
      });
      expect((await read(world.entity.id, term.startsAt)).subscription).toMatchObject({
        status: "active",
        isRefundPending: true,
        hasScheduledTerm: true,
      });
      expect((await read(world.entity.id, term.startsAt)).spendablePoints).toBe(0);
    },
    SLOW,
  );

  it.each(["malformed", "missing_plan", "missing_revision"] as const)(
    "%s 快照或引用明确失败而非默认标题",
    async (bad) => {
      const world = await h.make.merchant();
      const type = bad === "missing_revision" ? "plan_upgrade" : "plan_new";
      const snapshot =
        bad === "malformed"
          ? { kind: "plan" }
          : {
              ...content(type),
              ...(bad === "missing_plan" ? { planId: uuidv7() } : { toPlanRevisionId: uuidv7() }),
            };
      await h.make.billingOrder({
        entityId: world.entity.id,
        type,
        status: "cancelled",
        contentSnapshot: snapshot,
      });
      await expect(read(world.entity.id)).rejects.toMatchObject({ error: "INTERNAL" });
    },
    SLOW,
  );

  it(
    "读取结果中的kind/type错配拒绝，不绕原数据库CHECK造非法行",
    async () => {
      const world = await h.make.merchant();
      const row = await h.make.billingOrder({
        entityId: world.entity.id,
        type: "topup",
        status: "cancelled",
        contentSnapshot: content("topup"),
      });
      // 仅在读取边界注入损坏行，真实数据库原约束不改；完整SQL行为另有本叶真实样例。
      await h.tx.run(async (tx) => {
        const spy = vi.spyOn(tx.billingOrder, "findFirst").mockResolvedValueOnce({
          ...row,
          type: "plan_new",
        });
        try {
          await expect(
            readTenantAdminBillingFacts(tx, { entityId: world.entity.id, now: h.clock.now() }),
          ).rejects.toMatchObject({ error: "INTERNAL" });
        } finally {
          spy.mockRestore();
        }
      });
    },
    SLOW,
  );

  it(
    "callerTx未提交的新订单立即可见，回滚不留业务及读取旁写",
    async () => {
      const world = await h.make.merchant();
      const before = await snapshotTables(h.prisma, TABLES);
      const abort = new Error("回滚本测试事务");
      await expect(
        h.tx.run(async (tx) => {
          const make = createFactories({ db: tx, clock: h.clock });
          const order = await make.billingOrder({
            entityId: world.entity.id,
            contentSnapshot: content("plan_new"),
          });
          const inside = await snapshotTables(tx, TABLES);
          expect(
            (
              await readTenantAdminBillingFacts(tx, {
                entityId: world.entity.id,
                now: h.clock.now(),
              })
            ).subscription.latestPaymentOrder?.paymentOrderId,
          ).toBe(order.id);
          expect(await snapshotTables(tx, TABLES)).toEqual(inside);
          throw abort;
        }),
      ).rejects.toBe(abort);
      expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
      expect((await read(world.entity.id)).subscription.latestPaymentOrder).toBeNull();
    },
    SLOW,
  );
});
