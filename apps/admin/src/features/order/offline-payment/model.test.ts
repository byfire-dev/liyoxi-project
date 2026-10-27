import { expect, it } from "vitest";
import { PointAccountRowSchema, PointPackRowSchema, PlanAdminQuoteSchema } from "@liyoxi/contract";
import { offlineBody, proofBody, snapshotOfflinePack, type BoundEntityQuote } from "./model";
import { receiptFileAllowed } from "./upload";
const id = "0199e187-e72a-7000-8000-000000000001",
  other = "0199e187-e72a-7000-8000-000000000002",
  at = "2030-10-18T04:00:00.000Z";
const account = PointAccountRowSchema.parse({
  pointAccountId: id,
  entity: {
    entityId: id,
    name: "虚构付款主体",
    primaryStoreId: null,
    primaryStoreName: null,
    storeCount: 0,
    verificationStatus: "verified",
    managerStaff: null,
  },
  subscription: {
    status: "active",
    plan: { planId: other, name: "虚构套餐" },
    months: 1,
    startDate: "2030-10-01",
    endDate: "2030-10-31",
    endsAt: at,
    upgradedFrom: null,
  },
  planAvailablePoints: 0,
  planPointsExpireAt: at,
  addonAvailablePoints: 0,
  isAddonSuspended: false,
  heldPoints: 0,
  spendablePoints: 0,
  isRefundPending: false,
  hasPendingAdjustment: false,
});
const pack = PointPackRowSchema.parse({
  pointPackId: other,
  points: 100,
  priceFen: 1,
  isListed: true,
  position: 0,
  soldThisMonthCount: 0,
  soldThisMonthFen: "0",
  lockVersion: 7,
  updatedAt: at,
  actions: ["update", "delist"],
});
const rawQuote = PlanAdminQuoteSchema.parse({
  scope: "entity",
  generic: null,
  quote: {
    action: "upgrade",
    orderType: "plan_upgrade",
    planId: other,
    planRevisionId: id,
    planName: "虚构套餐",
    fromPlanName: "虚构原套餐",
    months: null,
    payFen: 6000,
    formula: {
      code: "plan_upgrade",
      args: { proratedFen: 0, topupPoints: 0 },
      text: "本月零点免收；后续完整月正常计费",
    },
    effectiveMode: "immediate",
    newTerm: null,
    firstGrantDate: null,
    benefits: {
      monthlyPoints: 100,
      discountBp: 10000,
      productionModel: "standard",
      maxStores: 1,
      maxMembers: null,
      schedulePriority: "standard",
      hasMonthlyReport: false,
    },
    upgrade: {
      currentTermEndDate: "2030-11-30",
      remainingDays: 1,
      baseDays: 30,
      remainingFullMonths: 1,
      feeDeltaPerMonthFen: 6000,
      monthlyDeltaPoints: 1,
      proratedFen: 0,
      topupPoints: 0,
    },
    downgradeImpact: null,
    promo: null,
    validUntil: at,
    quotedAt: at,
    policy: {
      mode: "offline_contract",
      isPriceShown: true,
      isPurchasePromptAllowed: false,
      channels: [],
      copy: {
        planNounKey: "billing.plan",
        pointsNounKey: "billing.points",
        agreementKeys: [],
        payButtonKey: "billing.pay",
      },
    },
  },
});
if (rawQuote.scope !== "entity") throw new Error("fixture须真实entity结构");
const bound: BoundEntityQuote = {
  accountId: id,
  planId: other,
  intent: "upgrade_now",
  result: rawQuote,
};
it("线下套餐金额/零点当月说明原样来自主体quote，不把0补成1点或2元，不附不存在的订购单关系", () => {
  const result = offlineBody(
    account,
    { kind: "plan", planId: other, intent: "upgrade_now", contractNo: "SYNTHETIC-417" },
    { quote: bound },
  );
  expect(result).toEqual({
    entityId: id,
    kind: "plan",
    planId: other,
    intent: "upgrade_now",
    contractNo: "SYNTHETIC-417",
    expectAmountFen: 6000,
    confirm: { entityName: "虚构付款主体", amountFen: 6000 },
  });
  expect(bound.result.quote.upgrade).toMatchObject({ proratedFen: 0, topupPoints: 0 });
  expect(result).not.toHaveProperty("orderId");
  expect(result).not.toHaveProperty("months");
});
it("主体/套餐/周期/意图更改后旧quote不能提交；积分包仅使用上架快照价和原ID", () => {
  const mutable = { ...pack },
    snapshot = snapshotOfflinePack(mutable);
  mutable.priceFen = 2;
  expect(
    offlineBody(
      account,
      { kind: "topup", pointPackId: other, contractNo: "SYNTHETIC-417" },
      { pack: snapshot },
    ).expectAmountFen,
  ).toBe(1);
  const draft = {
    kind: "plan" as const,
    planId: other,
    intent: "upgrade_now" as const,
    contractNo: "SYNTHETIC-417",
  };
  for (const wrong of [
    { ...bound, accountId: other },
    { ...bound, planId: id },
    { ...bound, intent: "renew_next_term" as const },
    { ...bound, months: 3 },
  ])
    expect(() => offlineBody(account, draft, { quote: wrong })).toThrow("重新获取");
  expect(
    offlineBody(
      account,
      { kind: "topup", pointPackId: other, contractNo: "SYNTHETIC-417" },
      { pack },
    ),
  ).toEqual({
    entityId: id,
    kind: "topup",
    pointPackId: other,
    contractNo: "SYNTHETIC-417",
    expectAmountFen: 1,
    confirm: { entityName: "虚构付款主体", amountFen: 1 },
  });
  expect(() =>
    offlineBody(
      account,
      { kind: "topup", pointPackId: other, contractNo: "SYNTHETIC-417" },
      { pack: { ...pack, isListed: false } },
    ),
  ).toThrow("上架");
  expect(() =>
    offlineBody(account, { kind: "topup", pointPackId: other, contractNo: "" }, { pack }),
  ).toThrow();
});
it("必须先stored fileId才能提交凭证，JPG/PNG5MB与PDF10MB实限，不接受网页图/空文件", () => {
  expect(() => proofBody(null, "虚构说明")).toThrow("入库");
  expect(proofBody(id, "  虚构说明  ")).toEqual({ fileId: id, note: "虚构说明" });
  expect(receiptFileAllowed({ name: "synthetic.png", size: 5 * 1024 * 1024 })).toBe(true);
  expect(receiptFileAllowed({ name: "synthetic.png", size: 5 * 1024 * 1024 + 1 })).toBe(false);
  expect(receiptFileAllowed({ name: "synthetic.pdf", size: 10 * 1024 * 1024 })).toBe(true);
  expect(receiptFileAllowed({ name: "synthetic.pdf", size: 10 * 1024 * 1024 + 1 })).toBe(false);
  expect(receiptFileAllowed({ name: "synthetic.webp", size: 100 })).toBe(false);
  expect(receiptFileAllowed({ name: "synthetic.png", size: 0 })).toBe(false);
});
