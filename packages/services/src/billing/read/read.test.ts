import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";

import { uuidv7 } from "../../kernel/index.js";
import { connectTestDatabase, useSeededDatabase } from "../../testing/index.js";
import { createLedgerHarness, openTerm, topUp } from "../testing/index.js";
import type { LedgerHarness } from "../testing/index.js";
import { getEntitlements, getWalletView, listOperationsByHold } from "./index.js";

// 读函数：权益按周期起止现算（不读 sub_status）、套餐与积分视图、按冻结单取账本操作。
// 读函数不拿锁、不推进、不写库：到点还没推进时也要给出到点之后的样子。

const SLOW = 120_000;
const at = (local: string): Date => new Date(`${local}+08:00`);

const db = useSeededDatabase("services");
let prisma: PrismaClient;
let h: LedgerHarness;

beforeAll(async () => {
  prisma = await db.prisma();
  h = createLedgerHarness(prisma);
}, SLOW);

describe("getEntitlements：按周期起止现算", () => {
  it(
    "从未开通 none；生效中给出周期与权益；到点没推进也算过期；预约周期到点没推进也算生效",
    async () => {
      h.clock.set(at("2026-01-05T12:00:00"));
      const { entity } = await h.make.merchant({ verified: true });
      expect(await getEntitlements(prisma, entity.id, h.clock.now())).toEqual({
        subStatus: "none",
        refundPending: false,
        term: null,
        lastTerm: null,
      });

      const first = await openTerm(h, { entityId: entity.id });
      const active = await getEntitlements(prisma, entity.id, h.clock.now());
      expect(active).toMatchObject({
        subStatus: "active",
        refundPending: false,
        lastTerm: null,
        term: {
          termId: first.term.id,
          months: 1,
          startDate: "2026-01-05",
          endDate: "2026-02-04",
          discountBp: 9000,
          monthlyPoints: 6600,
          productionModel: "advanced",
          schedulePriority: "priority",
          hasMonthlyReport: true,
          maxStores: 3,
          maxMembers: 10,
        },
      });
      // 止点前一毫秒还在生效；到了止点就过期——账户上的缓存还写着 active，没人推进
      const end = first.term.endsAt;
      expect(
        (await getEntitlements(prisma, entity.id, new Date(end.getTime() - 1))).subStatus,
      ).toBe("active");
      const expired = await getEntitlements(prisma, entity.id, end);
      expect(expired).toMatchObject({
        subStatus: "expired",
        term: null,
        lastTerm: { termId: first.term.id },
      });
      expect(
        (await prisma.billingAccount.findUniqueOrThrow({ where: { entityId: entity.id } }))
          .subStatus,
      ).toBe("active");

      // 有预约周期：到点没推进，也按新一期生效算
      const second = await openTerm(h, {
        entityId: entity.id,
        after: first.term,
        planCode: "flagship",
      });
      expect(await getEntitlements(prisma, entity.id, end)).toMatchObject({
        subStatus: "active",
        term: { termId: second.term.id, maxMembers: null, productionModel: "top" },
      });
      // 现在这一刻生效的还是第一期
      expect((await getEntitlements(prisma, entity.id, h.clock.now())).term?.termId).toBe(
        first.term.id,
      );
    },
    SLOW,
  );

  it(
    "退款处理中是主体级闸门：预约的那一期挂着退款申请也算",
    async () => {
      h.clock.set(at("2026-01-05T12:00:00"));
      const { entity } = await h.make.merchant({ verified: true });
      const first = await openTerm(h, { entityId: entity.id });
      const second = await openTerm(h, { entityId: entity.id, after: first.term });
      await topUp(h, { entityId: entity.id, points: 1000 });
      // 套餐退款在 M4，退款申请没有工厂：摘掉外键，直接在预约周期上摆出标记
      const owner = await connectTestDatabase(db.name, { role: null });
      try {
        await owner.query(
          "ALTER TABLE subscription_term DROP CONSTRAINT fk_subscription_term_refund_request_id",
        );
        await owner.query(
          "UPDATE subscription_term SET refund_request_id = $2, refund_rule = 'window' WHERE id = $1",
          [second.term.id, uuidv7()],
        );
      } finally {
        await owner.end();
      }

      expect(await getEntitlements(prisma, entity.id, h.clock.now())).toMatchObject({
        subStatus: "active",
        refundPending: true,
      });
      const wallet = await getWalletView(prisma, entity.id, h.clock.now());
      expect(wallet.subscription.isRefundPending).toBe(true);
      expect(wallet.points).toMatchObject({
        spendablePoints: 0,
        planAvailablePoints: 6600,
        addonAvailablePoints: 1000,
        isAddonSuspended: false,
      });
      // 账本操作行上的“操作后可花”也是 0，自检按同一个口径过
      await topUp(h, { entityId: entity.id, points: 1 });
      const last = await prisma.ledgerOperation.findFirstOrThrow({
        where: { entityId: entity.id },
        orderBy: { seq: "desc" },
      });
      expect(last).toMatchObject({ opType: "purchase", addonDeltaQty: 1, spendableAfterQty: 0 });
    },
    SLOW,
  );
});

describe("getWalletView：m07 第 2.7 节的 subscription、points 两段", () => {
  it(
    "生效中：套餐、周期、剩余天数、权益、预约周期；积分从批次现算",
    async () => {
      h.clock.set(at("2026-09-13T09:15:00"));
      const { entity } = await h.make.merchant({ verified: true });
      const first = await openTerm(h, { entityId: entity.id });
      await openTerm(h, {
        entityId: entity.id,
        after: first.term,
        months: 3,
        planCode: "flagship",
      });
      await topUp(h, { entityId: entity.id, points: 1000 });

      h.clock.set(at("2026-09-30T10:00:00"));
      const wallet = await getWalletView(prisma, entity.id, h.clock.now());
      expect(wallet.subscription).toEqual({
        status: "active",
        isRefundPending: false,
        plan: { planId: first.term.planId, code: "pro", name: "专业版" },
        months: 1,
        startDate: "2026-09-13",
        endDate: "2026-10-12",
        endsAt: at("2026-10-13T00:00:00"),
        // 09-30 看 10-12 到期：12 天
        remainingDays: 12,
        benefits: {
          discountBp: 9000,
          monthlyPoints: 6600,
          productionModel: "advanced",
          schedulePriority: "priority",
          hasMonthlyReport: true,
          maxStores: 3,
          maxMembers: 10,
        },
        scheduledTerms: [
          { planName: "旗舰版", months: 3, startDate: "2026-10-13", endDate: "2027-01-12" },
        ],
      });
      expect(wallet.points).toEqual({
        spendablePoints: 7600,
        planAvailablePoints: 6600,
        addonAvailablePoints: 1000,
        heldPoints: 0,
        isAddonSuspended: false,
        planGrantedThisTermPoints: 6600,
        planPointsExpireAt: at("2026-10-13T00:00:00"),
        lastExpired: null,
      });
    },
    SLOW,
  );

  it(
    "到期没推进：该清零的积分不显示成可用，加购积分停用；推进之后带上“已清零 N”",
    async () => {
      h.clock.set(at("2026-09-13T09:15:00"));
      const { entity } = await h.make.merchant({ verified: true });
      const { term } = await openTerm(h, { entityId: entity.id });
      await topUp(h, { entityId: entity.id, points: 3000 });

      h.clock.set(at("2026-10-13T00:00:05"));
      const stale = await getWalletView(prisma, entity.id, h.clock.now());
      expect(stale.subscription).toMatchObject({
        status: "expired",
        plan: { code: "pro" },
        endDate: "2026-10-12",
        remainingDays: null,
        scheduledTerms: [],
      });
      expect(stale.subscription.benefits?.monthlyPoints).toBe(6600);
      expect(stale.points).toEqual({
        spendablePoints: 0,
        planAvailablePoints: 0,
        addonAvailablePoints: 3000,
        heldPoints: 0,
        isAddonSuspended: true,
        planGrantedThisTermPoints: 0,
        planPointsExpireAt: null,
        lastExpired: null,
      });

      await h.tx.run((tx) => h.ledger.advance(tx, entity.id));
      const settled = await getWalletView(prisma, entity.id, h.clock.now());
      expect(settled.points).toEqual({
        ...stale.points,
        lastExpired: { expiredPoints: 6600, expiredAt: term.endsAt },
      });
      expect(settled.subscription).toEqual(stale.subscription);
    },
    SLOW,
  );

  it(
    "从未开通：都是空的",
    async () => {
      const { entity } = await h.make.merchant();
      const wallet = await getWalletView(prisma, entity.id, h.clock.now());
      expect(wallet.subscription).toMatchObject({ status: "none", plan: null, benefits: null });
      expect(wallet.points).toMatchObject({ spendablePoints: 0, isAddonSuspended: false });
    },
    SLOW,
  );
});

describe("listOperationsByHold", () => {
  it(
    "按冻结单取它的账本操作，按写入先后；没有的冻结单给空数组",
    async () => {
      h.clock.set(at("2026-11-01T10:00:00"));
      const { entity, store } = await h.make.merchant({ verified: true });
      const { term } = await openTerm(h, { entityId: entity.id });
      const hold = await h.make.pointHold({
        entityId: entity.id,
        storeId: store.id,
        subscriptionTermId: term.id,
      });
      // 冻结一族还没有：直接插两行操作（冻结、扣减），只为验读法
      const row = (opType: string, planDeltaQty: number) => ({
        id: uuidv7(),
        opKey: `${opType}:lyxtest:${hold.id}`,
        opType,
        entityId: entity.id,
        storeId: store.id,
        refType: "order_item",
        refId: hold.refId,
        pointHoldId: hold.id,
        occurredAt: h.clock.now(),
        bizDate: new Date("2026-11-01T00:00:00.000Z"),
        planDeltaQty,
        spendableAfterQty: 6600 + planDeltaQty,
        heldAfterQty: 100,
        titleCode: opType === "hold" ? "order_hold" : "capture",
        titleArgs: { count: 1 },
        actorType: "system",
        createdAt: h.clock.now(),
      });
      await prisma.ledgerOperation.create({ data: row("hold", -100) });
      await prisma.ledgerOperation.create({ data: row("capture", 0) });

      expect(await listOperationsByHold(prisma, hold.id)).toMatchObject([
        {
          opType: "hold",
          bizDate: "2026-11-01",
          planDeltaPoints: -100,
          addonDeltaPoints: 0,
          titleCode: "order_hold",
          titleArgs: { count: 1 },
        },
        { opType: "capture", planDeltaPoints: 0, titleCode: "capture" },
      ]);
      expect(await listOperationsByHold(prisma, uuidv7())).toEqual([]);
    },
    SLOW,
  );
});
