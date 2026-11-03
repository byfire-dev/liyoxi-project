import type { Body, Data } from "@/lib/account-api";
import { ApiError } from "@/lib/request";

type Plan = Data<"m.plan.list">["items"][number];
type Mode = Body<"m.plan.quote">["intent"];

/** 当前套餐可能已下架；找不到当前档位时不能把其他套餐一概当成可升级。 */
export function upgradeChoices(plans: readonly Plan[]) {
  const current = plans.find((plan) => plan.isCurrent);
  if (!current) return { plans: [], status: "unknown" as const };
  const higher = plans.filter((plan) => plan.rank > current.rank).sort((a, b) => a.rank - b.rank);
  return { plans: higher, status: higher.length ? ("available" as const) : ("highest" as const) };
}

export function selectablePlans(plans: readonly Plan[], mode: Mode): readonly Plan[] {
  return mode === "upgrade_now" ? upgradeChoices(plans).plans : plans;
}

export function initialPlanSelection(
  plans: readonly Plan[],
  mode: Mode,
): Body<"m.plan.quote"> | null {
  const choices = selectablePlans(plans, mode);
  const first =
    (mode === "renew_next_term"
      ? choices.find((plan) => plan.isCurrent && plan.cyclePrices.length > 0)
      : undefined) ?? choices.find((plan) => mode === "upgrade_now" || plan.cyclePrices.length > 0);
  if (!first) return null;
  return {
    planId: first.planId,
    ...(mode === "upgrade_now" ? {} : { months: first.cyclePrices[0]!.months }),
    ...(mode ? { intent: mode } : {}),
  };
}

export function planQuoteError(error: unknown): string {
  if (error instanceof ApiError && error.fieldErrors?.length)
    return error.fieldErrors.map((field) => field.message).join("；");
  return error instanceof Error ? error.message : "暂未取得报价，请重试";
}
