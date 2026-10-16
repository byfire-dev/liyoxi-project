import { beforeEach, expect, it } from "vitest";
import type { PlanQuoteBody, PurchasePolicy } from "@liyoxi/contract";
import {
  useSeededDatabase,
  createPaymentHarness,
  pendingPlanOrder,
  transferReceipt,
  applyReceipt,
  snapshotTables,
} from "../../testing/index.js";
import type { PaymentHarness } from "../../testing/index.js";
import { quotePlan } from "../catalog/index.js";
import { billingInvariants } from "../invariants.js";
import { subscriptionInvariants } from "./invariants.js";
import { paymentInvariants } from "../payment/invariants.js";
import { AppError, uuidv7 } from "../../kernel/index.js";
import { listTermsDueForReminder, renewalApplicable } from "./reminders.js";

const db = useSeededDatabase("services", { max: 1 });
beforeEach(() => db.reset(), 60000);
// 报价函数的策略入参；实际渠道/权限与确认由新增HTTP目标验证，不替换任何报价或账本函数。
const policy: PurchasePolicy = {
  mode: "in_app",
  isPriceShown: true,
  isPurchasePromptAllowed: true,
  channels: [{ code: "bank_transfer", isEnabled: true, isRecommended: true, hintKey: null }],
  copy: {
    planNounKey: "plan",
    pointsNounKey: "points",
    agreementKeys: ["member", "points"],
    payButtonKey: "pay",
  },
};
const tables = [
  "subscription_term",
  "subscription_event",
  "grant_schedule",
  "point_lot",
  "ledger_operation",
  "point_ledger_entry",
  "billing_account",
  "outbox_event",
];
async function quote(
  h: PaymentHarness,
  entityId: string,
  code: string,
  input: Omit<PlanQuoteBody, "planId"> = {},
) {
  const plan = await h.prisma.plan.findUniqueOrThrow({ where: { code } });
  return h.tx.run((tx) =>
    quotePlan(tx, entityId, h.clock.now(), { planId: plan.id, ...input }, async () => policy),
  );
}
async function payQuote(
  h: PaymentHarness,
  entityId: string,
  quoted: Awaited<ReturnType<typeof quote>>,
  uploadedAt = h.clock.now(),
) {
  const pending = await pendingPlanOrder(h, { entityId });
  // 仅建立付款前输入；paid/履约/积分一律由原applyPayment处理。
  const order = await h.prisma.billingOrder.update({
    where: { id: pending.id },
    data: {
      type: quoted.quote.orderType,
      contentSnapshot: quoted.content,
      amountFen: quoted.content.payFen,
    },
  });
  const proof = await h.make.transferProof({ entityId, billingOrderId: order.id, uploadedAt });
  const receipt = await transferReceipt(h, order);
  await h.prisma.paymentTxn.update({
    where: { id: receipt.id },
    data: { transferProofId: proof.id },
  });
  return { order, receipt, outcome: await applyReceipt(h, receipt) };
}
async function invariant(h: PaymentHarness, id: string) {
  for (const rule of [...billingInvariants, ...subscriptionInvariants, ...paymentInvariants])
    expect(
      await h.tx.run((tx) => rule.run!(tx, { entityIds: [id] }, { now: h.clock.now() })),
      rule.code,
    ).toEqual([]);
}

it("十三个月真实周期开通、降级续费和下期升级按锚点接续，逐月积分与尾差保持手算", async () => {
  const h = createPaymentHarness(await db.prisma());
  h.clock.set(new Date("2026-01-31T04:00:00Z"));
  const owner = await h.make.merchant({ verified: true }),
    entityId = owner.entity.id;
  const first = await payQuote(h, entityId, await quote(h, entityId, "pro", { months: 3 }));
  expect(first.outcome.result).toMatchObject({
    status: "applied",
    fulfillment: { status: "done" },
  });
  const down = await quote(h, entityId, "basic", { months: 3 });
  expect(down.quote).toMatchObject({
    action: "downgrade",
    orderType: "plan_renew",
    effectiveMode: "next_term",
  });
  await payQuote(h, entityId, down);
  const higher = await quote(h, entityId, "flagship", { months: 3, intent: "renew_next_term" });
  expect(higher.quote.action).toBe("renew_upgrade");
  await payQuote(h, entityId, higher);
  await payQuote(h, entityId, await quote(h, entityId, "pro", { months: 3 }));
  await payQuote(h, entityId, await quote(h, entityId, "basic", { months: 1 }));
  const terms = await h.prisma.subscriptionTerm.findMany({
    where: { entityId },
    orderBy: { termNo: "asc" },
  });
  expect(terms.map((t) => t.months)).toEqual([3, 3, 3, 3, 1]);
  for (let i = 1; i < terms.length; i++) expect(terms[i]!.startsAt).toEqual(terms[i - 1]!.endsAt);
  const schedules = await h.prisma.grantSchedule.findMany({
    where: { entityId },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
  });
  expect(schedules.map((s) => s.points)).toEqual([
    ...Array<number>(3).fill(6600),
    ...Array<number>(3).fill(3000),
    ...Array<number>(3).fill(14400),
    ...Array<number>(3).fill(6600),
    3000,
  ]);
  expect(schedules.reduce((sum, s) => sum + s.valueFen, 0)).toBe(8_400_000);
  for (const schedule of schedules) {
    h.clock.set(schedule.dueAt);
    await h.tx.run((tx) => h.ledger.advance(tx, entityId));
  }
  expect(await h.prisma.grantSchedule.count({ where: { entityId, status: "pending" } })).toBe(0);
  expect(
    (
      await h.prisma.pointLot.aggregate({
        where: { entityId, sourceType: "grant_monthly" },
        _sum: { originalQty: true },
      })
    )._sum.originalQty,
  ).toBe(94800);
  h.clock.set(terms.at(-1)!.endsAt);
  await h.tx.run((tx) => h.ledger.advance(tx, entityId));
  expect(await h.prisma.billingAccount.findUniqueOrThrow({ where: { entityId } })).toMatchObject({
    subStatus: "expired",
    planAvailableQty: 0,
  });
  await invariant(h, entityId);
}, 30000);

it("升级按付款行为时刻接受跨月确认，补发与后续改写成本唯一且同入账键零重复", async () => {
  const h = createPaymentHarness(await db.prisma());
  h.clock.set(new Date("2026-01-31T04:00:00Z"));
  const own = await h.make.merchant({ verified: true }),
    id = own.entity.id;
  await payQuote(h, id, await quote(h, id, "basic", { months: 3 }));
  h.clock.set(new Date("2026-02-20T04:00:00Z"));
  const upgraded = await quote(h, id, "pro");
  expect(upgraded.quote).toMatchObject({
    action: "upgrade",
    orderType: "plan_upgrade",
    months: null,
    upgrade: { remainingDays: 7, remainingFullMonths: 2, topupPoints: 840 },
  });
  const submitted = h.clock.now();
  h.clock.set(new Date("2026-03-02T04:00:00Z"));
  const paid = await payQuote(h, id, upgraded, submitted);
  expect(paid.outcome.result).toMatchObject({ status: "applied", fulfillment: { status: "done" } });
  const lots = await h.prisma.pointLot.findMany({
    where: { sourceType: "grant_upgrade", sourceId: paid.order.id },
    orderBy: { sourceNo: "asc" },
  });
  expect(lots.map((l) => [l.sourceNo, l.originalQty, l.costBasisFen])).toEqual([
    [0, 840, 70000],
    [1, 3600, 300000],
  ]);
  const term = await h.prisma.subscriptionTerm.findFirstOrThrow({
    where: { entityId: id, status: "active" },
  });
  expect(term).toMatchObject({ monthlyPoints: 6600, monthlyEquivFen: 600000 });
  expect(
    await h.prisma.grantSchedule.findUniqueOrThrow({
      where: { subscriptionTermId_monthNo: { subscriptionTermId: term.id, monthNo: 2 } },
    }),
  ).toMatchObject({ points: 6600, valueFen: 600000 });
  const before = await snapshotTables(h.prisma, tables);
  await applyReceipt(h, paid.receipt);
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  expect(
    await h.prisma.subscriptionEvent.count({
      where: { billingOrderId: paid.order.id, type: "upgraded" },
    }),
  ).toBe(1);
  await invariant(h, id);
  // 追加一个重复升级事件作为反例，再回滚该测试事务：钱仍只计一次，I12必须指出事件不唯一。
  const rollback = new Error("本轮反例回滚");
  await expect(
    h.tx.run(async (tx) => {
      await tx.subscriptionEvent.create({
        data: {
          id: uuidv7(),
          entityId: id,
          subscriptionTermId: term.id,
          billingOrderId: paid.order.id,
          type: "upgraded",
          occurredAt: h.clock.now(),
          bizDate: term.startDate,
          actorType: "system",
          actorClient: "worker",
          createdAt: h.clock.now(),
        },
      });
      const i12 = subscriptionInvariants.find((rule) => rule.code === "billing.I12")!;
      expect(await i12.run!(tx, { entityIds: [id] }, { now: h.clock.now() })).toMatchObject([
        {
          subject: { type: "billing_order", id: paid.order.id },
          detail: { problem: "upgrade_event_count", events: 2 },
        },
      ]);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  await invariant(h, id);
}, 30000);

it("R1从真实止日节点与后续周期重核，清零节点查询不写库且预约后立即失效", async () => {
  const h = createPaymentHarness(await db.prisma());
  h.clock.set(new Date("2026-01-31T04:00:00Z"));
  const own = await h.make.merchant({ verified: true }),
    id = own.entity.id;
  await payQuote(h, id, await quote(h, id, "pro", { months: 1 }));
  const term = await h.prisma.subscriptionTerm.findFirstOrThrow({
    where: { entityId: id, status: "active" },
  });
  h.clock.set(new Date("2026-02-20T04:00:00Z"));
  const before = await snapshotTables(h.prisma, tables);
  expect(
    await h.tx.run((tx) => listTermsDueForReminder(tx, { now: h.clock.now() })),
  ).toContainEqual({ termId: term.id, node: "T-7", date: "2026-02-20" });
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  await payQuote(h, id, await quote(h, id, "pro", { months: 1 }));
  expect(await h.tx.run((tx) => renewalApplicable(tx, term.id, h.clock.now()))).toBe(false);
  expect(
    await h.tx.run((tx) => listTermsDueForReminder(tx, { now: h.clock.now() })),
  ).not.toContainEqual(expect.objectContaining({ termId: term.id }));
  await invariant(h, id);
}, 30000);

it("升级写到权益变更后业务故障仍由保存点回滚补发与计划，已收款保留且报价末日拒绝", async () => {
  let fail = false;
  const h = createPaymentHarness(await db.prisma(), {
    onStep: (step) => {
      if (fail && step === "term.update") throw new AppError("STATE_NOT_ALLOWED");
    },
  });
  h.clock.set(new Date("2026-01-31T04:00:00Z"));
  const own = await h.make.merchant({ verified: true }),
    id = own.entity.id;
  await payQuote(h, id, await quote(h, id, "basic", { months: 3 }));
  const term = await h.prisma.subscriptionTerm.findFirstOrThrow({
    where: { entityId: id, status: "active" },
  });
  h.clock.set(new Date("2026-02-20T04:00:00Z"));
  const upgraded = await quote(h, id, "pro");
  const before = await snapshotTables(h.prisma, [
    "subscription_term",
    "grant_schedule",
    "point_lot",
    "ledger_operation",
    "point_ledger_entry",
  ]);
  fail = true;
  const paid = await payQuote(h, id, upgraded);
  fail = false;
  expect(paid.outcome.result).toMatchObject({
    status: "applied",
    fulfillment: { status: "blocked" },
  });
  expect(
    await snapshotTables(h.prisma, [
      "subscription_term",
      "grant_schedule",
      "point_lot",
      "ledger_operation",
      "point_ledger_entry",
    ]),
  ).toEqual(before);
  expect(
    await h.prisma.billingOrder.findUniqueOrThrow({ where: { id: paid.order.id } }),
  ).toMatchObject({
    status: "paid",
    fulfillmentStatus: "blocked",
    paidAmountFen: upgraded.content.payFen,
  });
  expect(
    await h.prisma.subscriptionEvent.count({
      where: { type: "upgraded", billingOrderId: paid.order.id },
    }),
  ).toBe(0);
  expect(
    await h.prisma.paymentException.count({
      where: { billingOrderId: paid.order.id, status: "open" },
    }),
  ).toBe(1);
  h.clock.set(new Date(term.endsAt.getTime() - 3600000));
  await expect(quote(h, id, "pro")).rejects.toMatchObject({ error: "UPGRADE_NOT_ALLOWED_TODAY" });
  await invariant(h, id);
}, 30000);
