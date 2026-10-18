import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";

import type { InvariantViolation } from "../../kernel/index.js";
import {
  assembleForTest,
  createFulfillHarness,
  fulfillOrder,
  paidPlanOrder,
  topUp,
  useSeededDatabase,
} from "../../testing/index.js";
import type { FulfillHarness } from "../../testing/index.js";
import { subscriptionInvariants } from "./invariants.js";
import { createBillingDailyProjection } from "../reporting/daily.js";
import { addDays, calendarDate } from "@liyoxi/shared/time";

// 验收 11（订阅一侧的三条）：billing.I9、I10、I12 各造一条违规都能查出；空库加种子、正常履约之后 0 违规。
// I10 的“重叠”要先去掉排他约束才造得出来，在 overlap.test.ts；这里造“首尾不相接”。
// 每条违规造在各自的主体上，按主体缩小范围来断言。

const SLOW = 180_000;
const MINUTE = 60_000;
const at = (local: string): Date => new Date(`${local}+08:00`);

const db = useSeededDatabase("services");
let prisma: PrismaClient;
let h: FulfillHarness;

beforeAll(async () => {
  prisma = await db.prisma();
  h = createFulfillHarness(prisma);
}, SLOW);

async function run(
  code: string,
  entityId?: string,
  now = h.clock.now(),
): Promise<readonly InvariantViolation[]> {
  const check = subscriptionInvariants.find((item) => item.code === code)?.run;
  if (check === undefined) throw new Error(`没有登记 ${code}`);
  return h.tx.run((tx) =>
    check(tx, entityId === undefined ? {} : { entityIds: [entityId] }, { now }),
  );
}
const runAll = async (entityId?: string): Promise<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const check of subscriptionInvariants) {
    counts[check.code] = (await run(check.code, entityId)).length;
  }
  return counts;
};
const CLEAN = {
  "billing.I9": 0,
  "billing.I10": 0,
  "billing.I11": 0,
  "billing.I12": 0,
  "billing.I13": 0,
  "billing.I15": 0,
};

/** 履约一张套餐付款单，并像入账函数那样把付款单写成履约完成 */
async function subscribe(entityId: string, input: { months?: number; renew?: boolean } = {}) {
  const order = await paidPlanOrder(h, {
    entityId,
    ...(input.months === undefined ? {} : { months: input.months }),
    type: input.renew ? "plan_renew" : "plan_new",
  });
  await fulfillOrder(h, order);
  await prisma.billingOrder.update({
    where: { id: order.id },
    data: { fulfillmentStatus: "done", fulfilledAt: h.clock.now() },
  });
  const term = await prisma.subscriptionTerm.findUniqueOrThrow({
    where: { sourceBillingOrderId: order.id },
  });
  return { order, term };
}

describe("billing 的不变量：订阅与日投影（验收 11）", () => {
  it("登记的是 I9–I13与I15：都只在full里跑、不自愈，财务守恒P1与状态排期P2", () => {
    expect(
      subscriptionInvariants.map((check) => [check.code, check.severity, check.modes, check.heal]),
    ).toEqual([
      ["billing.I9", "P2", ["full"], "none"],
      ["billing.I10", "P2", ["full"], "none"],
      ["billing.I11", "P1", ["full"], "none"],
      ["billing.I12", "P1", ["full"], "none"],
      ["billing.I13", "P1", ["full"], "none"],
      ["billing.I15", "P2", ["full"], "none"],
    ]);
    const registered = assembleForTest({ entry: "worker" }).invariants.map((check) => check.code);
    expect(registered).toEqual(expect.arrayContaining(Object.keys(CLEAN)));
  });

  it(
    "空库加种子 0 违规；开通、续费预约、加购、到点接续、过期后重新开通之后仍是 0 违规",
    async () => {
      expect(await runAll()).toEqual(CLEAN);

      h.clock.set(at("2026-01-05T12:00:00"));
      const { entity } = await h.make.merchant({ verified: true });
      await subscribe(entity.id, { months: 3 });
      await subscribe(entity.id, { renew: true });
      await topUp(h, { entityId: entity.id, points: 500 });
      expect(await runAll()).toEqual(CLEAN);
      for (const moment of ["2026-04-05T00:01:00", "2026-05-05T00:01:00"]) {
        h.clock.set(at(moment));
        await h.tx.run((tx) => h.ledger.advance(tx, entity.id));
        await h.tx.run((tx) =>
          createBillingDailyProjection({ ledger: h.ledger }).snapshot(
            tx,
            entity.id,
            addDays(calendarDate(h.clock.now()), -1),
          ),
        );
        expect(await runAll(), moment).toEqual(CLEAN);
      }
      h.clock.set(at("2026-06-01T09:00:00"));
      await subscribe(entity.id, { renew: true });
      await h.tx.run((tx) =>
        createBillingDailyProjection({ ledger: h.ledger }).snapshot(
          tx,
          entity.id,
          addDays(calendarDate(h.clock.now()), -1),
        ),
      );
      expect(await runAll()).toEqual(CLEAN);
    },
    SLOW,
  );

  it(
    "I9：到期超过 10 分钟还挂着生效；账户不是生效却有生效中的周期",
    async () => {
      h.clock.set(at("2026-07-01T12:00:00"));
      const a = await h.make.merchant({ verified: true });
      const { term } = await subscribe(a.entity.id);
      expect(await run("billing.I9", a.entity.id)).toEqual([]);
      // 止点后 5 分钟：扫描每分钟一轮，还在宽限之内；过了 10 分钟仍没推进才报
      expect(
        await run("billing.I9", a.entity.id, new Date(term.endsAt.getTime() + 5 * MINUTE)),
      ).toEqual([]);
      expect(
        await run("billing.I9", a.entity.id, new Date(term.endsAt.getTime() + 11 * MINUTE)),
      ).toMatchObject([
        {
          subject: { type: "billing_account", id: a.entity.id },
          entityId: a.entity.id,
          detail: { subStatus: "active", activeTerms: 1, inForce: 0 },
        },
      ]);

      // 工厂直接插的生效周期，账户还是“从未开通”
      const b = await h.make.merchant({ verified: true });
      await h.make.subscriptionTerm({ entityId: b.entity.id });
      expect(await run("billing.I9", b.entity.id)).toMatchObject([
        { detail: { subStatus: "none", activeTerms: 1 } },
      ]);
      expect(await run("billing.I9", a.entity.id)).toEqual([]);
    },
    SLOW,
  );

  it(
    "I10：预约周期没有接在上一期的止点上",
    async () => {
      h.clock.set(at("2026-07-01T12:00:00"));
      const { entity } = await h.make.merchant({ verified: true });
      await subscribe(entity.id);
      const { term: queued } = await subscribe(entity.id, { renew: true });
      expect(await run("billing.I10", entity.id)).toEqual([]);
      // 把预约周期整体往后挪一天：与上一期之间空出一天
      await prisma.subscriptionTerm.update({
        where: { id: queued.id },
        data: {
          startDate: new Date("2026-08-02T00:00:00.000Z"),
          endDate: new Date("2026-09-01T00:00:00.000Z"),
          startsAt: at("2026-08-02T00:00:00"),
          endsAt: at("2026-09-02T00:00:00"),
        },
      });
      expect(await run("billing.I10", entity.id)).toMatchObject([
        {
          subject: { type: "subscription_term", id: queued.id },
          entityId: entity.id,
          detail: { problem: "gap" },
        },
      ]);
    },
    SLOW,
  );

  it(
    "I12：履约完成的套餐付款单没有周期、发放计划合计 ≠ 实付；履约完成的加购付款单没有批次",
    async () => {
      h.clock.set(at("2026-07-01T12:00:00"));
      const { entity } = await h.make.merchant({ verified: true });
      const { order, term } = await subscribe(entity.id, { months: 3 });
      const { billingOrderId } = await topUp(h, { entityId: entity.id, points: 500 });
      expect(await run("billing.I12", entity.id)).toEqual([]);

      // 工厂缺省造的付款单：已支付、履约完成，却没有经过履约（没有周期）
      const orphan = await h.make.billingOrder({ entityId: entity.id });
      const noLot = await h.make.billingOrder({ entityId: entity.id, type: "topup" });
      // 发放计划的分摊被改动：合计不再等于实付
      await prisma.grantSchedule.updateMany({
        where: { subscriptionTermId: term.id, monthNo: 2 },
        data: { valueFen: { increment: 1 } },
      });
      const found = await run("billing.I12", entity.id);
      const of = (id: string) =>
        found.find((item) => item.subject && "id" in item.subject && item.subject.id === id);
      expect(found).toHaveLength(3);
      expect(of(orphan.id)).toMatchObject({
        subject: { type: "billing_order" },
        entityId: entity.id,
        detail: { problem: "term_count", terms: 0 },
      });
      expect(of(order.id)).toMatchObject({
        detail: {
          problem: "schedule_value",
          paidAmountFen: 1_800_000,
          scheduleValueFen: 1_800_001,
        },
      });
      expect(of(noLot.id)).toMatchObject({ detail: { problem: "lot_count", lots: 0 } });
      expect(of(billingOrderId)).toBeUndefined();
    },
    SLOW,
  );
  it(
    "I12：套餐批次成本差一分或月间挪用，计划合计仍等于实付，也必须报违规",
    async () => {
      h.clock.set(at("2026-07-05T12:00:00"));
      const { entity } = await h.make.merchant({ verified: true });
      const { order, term } = await subscribe(entity.id, { months: 3 });
      const first = await prisma.grantSchedule.findFirstOrThrow({
        where: { subscriptionTermId: term.id, monthNo: 0 },
      });
      expect(first.pointLotId).not.toBeNull();
      expect(await run("billing.I12", entity.id)).toEqual([]);

      await prisma.pointLot.update({
        where: { id: first.pointLotId as string },
        data: { costBasisFen: { increment: 1 } },
      });
      expect(await run("billing.I12", entity.id)).toMatchObject([
        {
          subject: { type: "billing_order", id: order.id },
          detail: {
            problem: "issued_lot_cost",
            paidAmountFen: 1_800_000,
            scheduleValueFen: 1_800_000,
            settledValueFen: 1_800_001,
            issuedLotMismatches: 1,
          },
        },
      ]);

      // 两个月的成本相互挪一分：总额仍守恒，每个月也必须对上自己的分摊。
      await prisma.pointLot.update({
        where: { id: first.pointLotId as string },
        data: { costBasisFen: { decrement: 1 } },
      });
      h.clock.set(at("2026-08-05T00:01:00"));
      await h.tx.run((tx) => h.ledger.advance(tx, entity.id));
      const second = await prisma.grantSchedule.findFirstOrThrow({
        where: { subscriptionTermId: term.id, monthNo: 1 },
      });
      expect(second.pointLotId).not.toBeNull();
      expect(await run("billing.I12", entity.id)).toEqual([]);
      await h.tx.run(async (tx) => {
        await tx.pointLot.update({
          where: { id: first.pointLotId as string },
          data: { costBasisFen: { increment: 1 } },
        });
        await tx.pointLot.update({
          where: { id: second.pointLotId as string },
          data: { costBasisFen: { decrement: 1 } },
        });
      });
      expect(await run("billing.I12", entity.id)).toMatchObject([
        {
          subject: { type: "billing_order", id: order.id },
          detail: {
            problem: "issued_lot_cost",
            paidAmountFen: 1_800_000,
            scheduleValueFen: 1_800_000,
            settledValueFen: 1_800_000,
            issuedLotMismatches: 2,
          },
        },
      ]);
    },
    SLOW,
  );
});
