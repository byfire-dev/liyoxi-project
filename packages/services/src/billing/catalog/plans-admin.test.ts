import { beforeEach, expect, it } from "vitest";
import { addDays } from "@liyoxi/shared/time";
import type { PurchasePolicy } from "@liyoxi/contract";
import {
  applyReceipt,
  createPaymentHarness,
  pendingPlanOrder,
  sampleStaffContext,
  snapshotTables,
  transferReceipt,
  useSeededDatabase,
} from "../../testing/index.js";
import type { PaymentHarness } from "../../testing/index.js";
import { createNotices } from "../../config/index.js";
import { staffBriefs } from "../../staff/index.js";
import { uuidv7 } from "../../kernel/index.js";
import { createPlanAdmin } from "./plans-admin.js";
import { quotePlan } from "./index.js";
const db = useSeededDatabase("services", { max: 1 });
beforeEach(() => db.reset(), 60000);
const tables = [
  "plan",
  "plan_revision",
  "billing_param",
  "billing_account",
  "subscription_term",
  "subscription_event",
  "grant_schedule",
  "point_lot",
  "ledger_operation",
  "point_ledger_entry",
  "billing_order",
  "payment_txn",
  "plan_promo_claim",
  "audit_log",
  "status_transition",
  "outbox_event",
  "idempotency_record",
];
const policy: PurchasePolicy = {
  mode: "in_app",
  isPriceShown: true,
  isPurchasePromptAllowed: false,
  channels: [],
  copy: { planNounKey: "", pointsNounKey: "", agreementKeys: [], payButtonKey: "" },
};
async function world() {
  const h = createPaymentHarness(await db.prisma()),
    operator = await h.make.staff({ staffRoleKey: "super_admin" }),
    staff = await sampleStaffContext(h.prisma, operator.id),
    plans = createPlanAdmin({
      tx: h.tx,
      clock: h.clock,
      events: h.events,
      staffBriefs,
      notices: createNotices({ clock: h.clock, events: h.events }),
    });
  return { ...h, staff, plans };
}
async function param(
  h: PaymentHarness,
  key: "maxScheduledTerms" | "prorationBaseDays",
  value: number,
) {
  h.clock.advance(1);
  await h.prisma.billingParam.create({
    data: {
      id: uuidv7(),
      changeId: uuidv7(),
      key,
      value,
      effectiveAt: h.clock.now(),
      createdAt: h.clock.now(),
    },
  });
}
async function paid(h: PaymentHarness, entityId: string, renewal = false) {
  const pending = await pendingPlanOrder(h, { entityId }),
    order = renewal
      ? await h.prisma.billingOrder.update({
          where: { id: pending.id },
          data: { type: "plan_renew" },
        })
      : pending,
    receipt = await transferReceipt(h, order);
  expect((await applyReceipt(h, receipt)).result).toMatchObject({
    status: "applied",
    fulfillment: { status: "done" },
  });
  return h.prisma.subscriptionTerm.findUniqueOrThrow({ where: { sourceBillingOrderId: order.id } });
}
const commonQuote = (h: PaymentHarness, entityId: string, planId: string, upgrade = false) =>
  h.tx.run((tx) =>
    quotePlan(
      tx,
      entityId,
      h.clock.now(),
      {
        planId,
        ...(upgrade ? {} : { months: 1, intent: "renew_next_term" as const }),
      },
      async () => policy,
    ),
  );
async function pair(h: PaymentHarness) {
  const source = await h.prisma.plan.create({
      data: {
        id: uuidv7(),
        code: "quote_source",
        name: "报价来源",
        rank: 50,
        scope: "public",
        isListed: false,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    }),
    target = await h.prisma.plan.create({
      data: {
        id: uuidv7(),
        code: "quote_target",
        name: "报价目标",
        rank: 51,
        scope: "public",
        isListed: true,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
  const revision = (
    planId: string,
    monthlyFeeFen: number,
    monthlyPoints: number,
    revisionNo = 1,
    effectiveAt = new Date(h.clock.now().getTime() - 1000),
  ) =>
    h.prisma.planRevision.create({
      data: {
        id: uuidv7(),
        planId,
        revisionNo,
        monthlyFeeFen,
        monthlyPoints,
        discountBp: 10000,
        productionModel: "standard",
        maxStores: 1,
        maxMembers: 3,
        schedulePriority: "standard",
        hasMonthlyReport: false,
        cyclePrices: { "1": monthlyFeeFen, "3": monthlyFeeFen * 3 - 3000 },
        effectiveAt,
        createdAt: h.clock.now(),
      },
    });
  await revision(source.id, 10000, 100);
  await revision(target.id, 16000, 101);
  return { source, target, revision };
}

it("通用报价只读当前修订和真实周期价；零积分当月免收，完整月仍按实际差额", async () => {
  const h = await world(),
    { source, target, revision } = await pair(h);
  await revision(target.id, 99999, 101, 2, new Date(h.clock.now().getTime() + 86400000));
  const before = await snapshotTables(h.prisma, tables),
    body = { kind: "upgrade", planId: target.id, fromPlanId: source.id, remainingDays: 1 };
  expect(await h.plans.quote(h.staff, body)).toEqual({
    scope: "generic",
    quote: null,
    generic: {
      feeDeltaPerMonthFen: 6000,
      monthlyDeltaPoints: 1,
      remainingDays: 1,
      baseDays: 30,
      proratedFen: 0,
      topupPoints: 0,
      formulaText: "¥60 × 1 ÷ 30 ＝ ¥0（折算积分为0，当月免收）",
    },
  });
  expect(await h.plans.quote(h.staff, { ...body, remainingDays: 30 })).toMatchObject({
    generic: {
      proratedFen: 6000,
      topupPoints: 1,
    },
  });
  expect(await h.plans.quote(h.staff, { kind: "renewal", planId: target.id, months: 3 })).toEqual({
    scope: "generic",
    quote: null,
    generic: {
      cyclePriceFen: 45000,
      monthlyPoints: 101,
      months: 3,
      formulaText: "3 个月 ¥450",
    },
  });
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
});

it("通用报价拒绝反向rank、非法折算基数/周期及未生效/下架目标，失败也零写", async () => {
  const h = await world(),
    { source, target, revision } = await pair(h),
    upgrade = { kind: "upgrade", planId: target.id, fromPlanId: source.id, remainingDays: 2 };
  await param(h, "prorationBaseDays", 1);
  const before = await snapshotTables(h.prisma, tables);
  for (const body of [
    upgrade,
    { ...upgrade, fromPlanId: target.id, remainingDays: 1 },
    { kind: "upgrade", planId: target.id },
    { kind: "renewal", planId: target.id },
  ])
    await expect(Promise.resolve().then(() => h.plans.quote(h.staff, body))).rejects.toMatchObject({
      error: "VALIDATION_FAILED",
    });
  await expect(
    h.plans.quote(h.staff, { kind: "renewal", planId: target.id, months: 2 }),
  ).rejects.toMatchObject({ error: "CYCLE_NOT_AVAILABLE", details: { enabledCycles: [1, 3, 12] } });
  await expect(
    h.plans.quote(h.staff, { kind: "renewal", planId: source.id, months: 1 }),
  ).rejects.toMatchObject({ error: "PLAN_NOT_AVAILABLE" });
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  const future = await h.prisma.plan.create({
    data: {
      ...target,
      id: uuidv7(),
      code: "quote_future",
      rank: 52,
    },
  });
  await revision(future.id, 16000, 101, 1, new Date(h.clock.now().getTime() + 86400000));
  const pending = await snapshotTables(h.prisma, tables);
  await expect(
    h.plans.quote(h.staff, { kind: "renewal", planId: future.id, months: 1 }),
  ).rejects.toMatchObject({ error: "PLAN_NOT_AVAILABLE" });
  expect(await snapshotTables(h.prisma, tables)).toEqual(pending);
});

it("预约上限仅挡新续费报价；立即升级及已接受付款的冻结履约不受软上限截断", async () => {
  const h = await world(),
    who = await h.make.merchant({ verified: true }),
    id = who.entity.id;
  const first = await paid(h, id);
  await paid(h, id, true);
  // 在报价前已有的待确认输入；其后真实收款按冻结内容履约，不能重新施加报价软限。
  const accepted = await pendingPlanOrder(h, { entityId: id });
  await h.prisma.billingOrder.update({ where: { id: accepted.id }, data: { type: "plan_renew" } });
  const pro = await h.prisma.plan.findUniqueOrThrow({ where: { code: "pro" } }),
    flagship = await h.prisma.plan.findUniqueOrThrow({ where: { code: "flagship" } }),
    before = await snapshotTables(h.prisma, tables);
  await expect(commonQuote(h, id, pro.id)).rejects.toMatchObject({
    error: "SCHEDULED_TERM_LIMIT",
    details: { maxScheduledTerms: 1 },
  });
  await expect(
    h.plans.quote(h.staff, { kind: "renewal", planId: pro.id, months: 1, pointAccountId: id }),
  ).rejects.toMatchObject({ error: "SCHEDULED_TERM_LIMIT" });
  expect((await commonQuote(h, id, flagship.id, true)).quote.action).toBe("upgrade");
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  const at = h.clock.now();
  // 没有逻辑当期也不能因包装层漏查未来预约而绕过名额。
  h.clock.set(new Date(first.startsAt.getTime() - 1));
  await expect(commonQuote(h, id, pro.id)).rejects.toMatchObject({ error: "SCHEDULED_TERM_LIMIT" });
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  h.clock.set(at);
  const receipt = await transferReceipt(h, accepted);
  expect((await applyReceipt(h, receipt)).result).toMatchObject({
    status: "applied",
    fulfillment: { status: "done" },
  });
  expect(
    await h.prisma.subscriptionTerm.count({ where: { entityId: id, status: "scheduled" } }),
  ).toBe(2);
});

it("到点未推进的预约是当期；零上限不阻首次开通，已有周期不得再新增预约", async () => {
  const h = await world(),
    pro = await h.prisma.plan.findUniqueOrThrow({ where: { code: "pro" } }),
    who = await h.make.merchant({ verified: true }),
    id = who.entity.id;
  await param(h, "maxScheduledTerms", 0);
  const before = await snapshotTables(h.prisma, tables);
  expect((await commonQuote(h, id, pro.id)).quote.action).toBe("subscribe");
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  await paid(h, id);
  await expect(commonQuote(h, id, pro.id)).rejects.toMatchObject({ error: "SCHEDULED_TERM_LIMIT" });
  await param(h, "maxScheduledTerms", 1);
  const next = await paid(h, id, true);
  h.clock.set(next.startsAt);
  const logical = await snapshotTables(h.prisma, tables);
  expect((await commonQuote(h, id, pro.id)).quote).toMatchObject({
    action: "renew",
    newTerm: { startDate: addDays(next.endDate.toISOString().slice(0, 10), 1) },
  });
  expect(
    await h.prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: next.id } }),
  ).toMatchObject({ status: "scheduled" });
  expect(await snapshotTables(h.prisma, tables)).toEqual(logical);
});
