import { describe, expect, it } from "vitest";

import {
  billingCopy,
  purchaseVisible,
  walletPurchaseLabel,
  type Policy,
  type Wallet,
} from "./model";

const policy: Policy = {
  mode: "in_app",
  isPriceShown: true,
  isPurchasePromptAllowed: true,
  channels: [{ code: "bank_transfer", isEnabled: true, isRecommended: true, hintKey: null }],
  copy: {
    planNounKey: "plan",
    pointsNounKey: "points",
    payButtonKey: "pay",
    agreementKeys: ["member", "points"],
  },
};
const wallet = (status: Wallet["subscription"]["status"]): Wallet => ({
  subscription: {
    status,
    isRefundPending: false,
    plan: null,
    months: null,
    startDate: null,
    endDate: null,
    endsAt: null,
    remainingDays: null,
    benefits: null,
    scheduledTerms: [],
  },
  usage: { storesUsed: 1, storeLimit: 1, seatsUsed: 1, memberLimit: null, limitReason: "inactive" },
  points: {
    spendablePoints: 0,
    planAvailablePoints: 0,
    addonAvailablePoints: 0,
    heldPoints: 0,
    isAddonSuspended: true,
    planGrantedThisTermPoints: 0,
    planPointsExpireAt: null,
    lastExpired: null,
  },
  topUp: { canTopUp: false, blockReason: "no_active_plan" },
  rules: {
    adUnitPoints: 50,
    discountedAdUnitPoints: null,
    adFreeRevisions: 2,
    topModelSurchargeBp: 2000,
  },
});

describe("钱包购买入口", () => {
  it.each(["offline_contract", "hidden"] as const)(
    "%s 策略不暴露价格或购买按钮，即便其他位为真",
    (mode) => {
      const restricted = { ...policy, mode };
      expect(purchaseVisible(restricted)).toBe(false);
      expect(walletPurchaseLabel(wallet("none"), restricted, {})).toBeNull();
      expect(walletPurchaseLabel(wallet("expired"), restricted, {})).toBeNull();
    },
  );
  it("in_app 的两个服务端显示位都必须允许", () => {
    expect(purchaseVisible({ ...policy, isPriceShown: false })).toBe(false);
    expect(purchaseVisible({ ...policy, isPurchasePromptAllowed: false })).toBe(false);
  });
  it("M1 只提供未开通和过期态入口，生效中不展示续费/升级", () => {
    expect(walletPurchaseLabel(wallet("none"), policy, {})).toBe("开通套餐");
    expect(walletPurchaseLabel(wallet("expired"), policy, {})).toBe("续费");
    expect(walletPurchaseLabel(wallet("active"), policy, {})).toBeNull();
  });
  it("策略决定称呼的键，bootstrap 仅覆盖文案，未知键不自行替换", () => {
    expect(billingCopy("points", {})).toBe("积分");
    expect(billingCopy("pay", { pay: "确认付款" })).toBe("确认付款");
    const custom = { ...policy, copy: { ...policy.copy, planNounKey: "service_plan" } };
    expect(walletPurchaseLabel(wallet("none"), custom, { service_plan: "服务方案" })).toBe(
      "开通服务方案",
    );
    expect(walletPurchaseLabel(wallet("none"), custom, {})).toBeNull();
  });
  it("服务端给退款处理中时，不出现购买引导", () => {
    const blocked = wallet("expired");
    blocked.subscription.isRefundPending = true;
    expect(walletPurchaseLabel(blocked, policy, {})).toBeNull();
  });
});
