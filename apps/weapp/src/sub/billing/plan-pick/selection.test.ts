import { describe, expect, it } from "vitest";
import { billingPlans } from "../../../../shots/billing-fixtures";
import { ApiError } from "@/lib/request";
import { initialPlanSelection, planQuoteError, selectablePlans, upgradeChoices } from "./selection";

const plansFor = (rank: number | null) =>
  [1, 2, 3].map((value) => ({
    ...billingPlans.items[0]!,
    planId: `plan-${value}`,
    rank: value,
    isCurrent: value === rank,
  }));

describe("套餐升级候选与默认选择", () => {
  it("中档升级只提供更高档，默认请求不携带新周期", () => {
    const plans = plansFor(2);
    expect(selectablePlans(plans, "upgrade_now").map((plan) => plan.planId)).toEqual(["plan-3"]);
    expect(initialPlanSelection(plans, "upgrade_now")).toEqual({
      planId: "plan-3",
      intent: "upgrade_now",
    });
  });

  it("最高档没有升级候选，不回退选择低档或当前档位", () => {
    const plans = plansFor(3);
    expect(upgradeChoices(plans)).toEqual({ plans: [], status: "highest" });
    expect(initialPlanSelection(plans, "upgrade_now")).toBeNull();
  });

  it("当前套餐未出现在目录时明确未知，不误判最高档或发起升级", () => {
    const plans = plansFor(null);
    expect(upgradeChoices(plans)).toEqual({ plans: [], status: "unknown" });
    expect(initialPlanSelection(plans, "upgrade_now")).toBeNull();
    expect(upgradeChoices([]).status).toBe("unknown");
  });

  it("乱序目录仍默认选择最近的更高档，不修改原始目录顺序", () => {
    const plans = plansFor(1).reverse();
    expect(initialPlanSelection(plans, "upgrade_now")?.planId).toBe("plan-2");
    expect(plans.map((plan) => plan.rank)).toEqual([3, 2, 1]);
  });

  it("续费保留当前套餐与周期，开通仍能默认选套餐", () => {
    const plans = plansFor(2);
    expect(initialPlanSelection(plans, "renew_next_term")).toEqual({
      planId: "plan-2",
      months: 1,
      intent: "renew_next_term",
    });
    expect(selectablePlans(plans, "renew_next_term")).toHaveLength(3);
    expect(initialPlanSelection(plansFor(null), undefined)).toEqual({
      planId: "plan-1",
      months: 1,
    });
    expect(initialPlanSelection([], undefined)).toBeNull();
  });
});

it("报价失败展示字段原因，并保留网络错误文案", () => {
  expect(
    planQuoteError(
      new ApiError({
        error: "VALIDATION_FAILED",
        status: 400,
        message: "参数校验失败",
        requestId: "quote-test",
        fieldErrors: [{ path: "planId", message: "立即升级请选择高于当前档位的套餐" }],
      }),
    ),
  ).toBe("立即升级请选择高于当前档位的套餐");
  expect(planQuoteError(new Error("网络连接失败，请重试"))).toBe("网络连接失败，请重试");
});
