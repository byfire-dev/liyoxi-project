import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DEFAULT_CONTROLS, getPurchasePolicy, versionMatches } from "./index.js";
import type { PolicyInput, PurchaseRule } from "./index.js";
const input: PolicyInput = {
  platform: "ios",
  appVersion: "1.2.3",
  entityId: "e",
  type: "plan_new",
  amountFen: 10000,
  providers: { wechatPayConfigured: false },
  bankAccountConfigured: true,
  bankMinFen: 100,
};
describe("购买策略的公共纯计算", () => {
  it("有序首匹配，不把后续规则叠加；全部 when 维度共同成立", () => {
    const rules: PurchaseRule[] = [
      { when: { platforms: ["android"] }, then: { mode: "hidden" } },
      {
        when: {
          platforms: ["ios"],
          versionRange: ">=1.2.0 <2.0.0",
          entityIds: ["e"],
          types: ["plan_new"],
          amountGteFen: 10000,
          amountLtFen: 10001,
        },
        then: { channels: { bank_transfer: "off" } },
      },
      { when: {}, then: { mode: "hidden" } },
    ];
    expect(getPurchasePolicy(input, rules)).toMatchObject({
      mode: "in_app",
      channels: [{ isEnabled: false }, { isEnabled: false }],
    });
    expect(getPurchasePolicy({ ...input, amountFen: 10001 }, rules).mode).toBe("hidden");
    expect(versionMatches(undefined, ">=1.2.0")).toBe(false);
    expect(versionMatches("1.2.3", ">=1.2.0 <2.0.0")).toBe(true);
    expect(versionMatches("1.2.3", "broken")).toBe(false);
  });
  it("非应用内模式在任意价格和渠道配置下均没有渠道、价格或购买引导", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000_000 }),
        fc.boolean(),
        fc.constantFrom("hidden" as const, "offline_contract" as const),
        (amountFen, configured, mode) => {
          const p = getPurchasePolicy(
            { ...input, amountFen, providers: { wechatPayConfigured: configured } },
            [{ when: {}, then: { mode, channels: { bank_transfer: "on", wechat_jsapi: "on" } } }],
          );
          expect(p).toMatchObject({
            mode,
            isPriceShown: false,
            isPurchasePromptAllowed: false,
            channels: [],
          });
        },
      ),
      { numRuns: 200 },
    );
  });
  it("配置规则不能绕过 Provider、最低金额及限额；对公建议只在确有可用渠道时给出", () => {
    expect(
      getPurchasePolicy({ ...input, amountFen: 99 }, []).channels.every(
        (c) => !c.isEnabled && !c.isRecommended,
      ),
    ).toBe(true);
    expect(
      getPurchasePolicy({ ...input, bankAccountConfigured: false }, []).channels.every(
        (c) => !c.isEnabled,
      ),
    ).toBe(true);
    const controls = {
      ...DEFAULT_CONTROLS,
      wechatSingleLimitFen: 10000,
      wechatDailyLimitFen: 20000,
    };
    expect(
      getPurchasePolicy(
        { ...input, providers: { wechatPayConfigured: true }, payerPaidTodayFen: 10001 },
        [],
        controls,
      ).channels[0]?.isEnabled,
    ).toBe(false);
    expect(
      getPurchasePolicy(
        { ...input, providers: { wechatPayConfigured: true }, payerPaidTodayFen: 10000 },
        [],
        controls,
      ).channels[0]?.isEnabled,
    ).toBe(true);
    expect(getPurchasePolicy(input, []).copy.agreementKeys).toEqual(["member", "points"]);
    expect(getPurchasePolicy({ ...input, type: "topup" }, []).copy.agreementKeys).toEqual([
      "points",
    ]);
  });
});
