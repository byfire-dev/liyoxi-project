import { PlanCardSchema, PlanQuoteSchema } from "@liyoxi/contract";
import type { PlanQuoteBody, PurchasePolicy } from "@liyoxi/contract";
import { termDates } from "@liyoxi/shared/period";
import { calendarDate } from "@liyoxi/shared/time";
import { formatMoney } from "@liyoxi/shared/format/money";
import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { getEntitlements } from "../read/index.js";
import { paramsAt } from "../pricing/index.js";

export const benefitsOf = (r: {
  monthlyPoints: number;
  discountBp: number;
  productionModel: string;
  schedulePriority: string;
  maxStores: number;
  maxMembers: number | null;
  hasMonthlyReport: boolean;
}) => ({
  monthlyPoints: r.monthlyPoints,
  discountBp: r.discountBp,
  productionModel: r.productionModel,
  schedulePriority: r.schedulePriority,
  maxStores: r.maxStores,
  maxMembers: r.maxMembers,
  hasMonthlyReport: r.hasMonthlyReport,
});
export async function planAt(tx: Tx, id: string, at: Date) {
  const plan = await tx.plan.findUnique({ where: { id } });
  if (!plan) throw new AppError("NOT_FOUND");
  const revision = await tx.planRevision.findFirst({
    where: { planId: id, effectiveAt: { lte: at }, cancelledAt: null },
    orderBy: [{ effectiveAt: "desc" }, { revisionNo: "desc" }],
  });
  if (!plan.isListed || !revision) throw new AppError("PLAN_NOT_AVAILABLE");
  return { plan, revision };
}
export function formulaOf(monthlyFeeFen: number, cyclePriceFen: number, months: number) {
  const monthly = monthlyFeeFen * months === cyclePriceFen;
  return {
    code: monthly ? ("plan_monthly" as const) : ("plan_cycle" as const),
    args: monthly ? { monthlyFeeFen, months } : { cyclePriceFen, months },
    text: monthly
      ? `${formatMoney(monthlyFeeFen)} × ${months} 个月 ＝ ${formatMoney(cyclePriceFen)}`
      : `${months} 个月 ${formatMoney(cyclePriceFen)}`,
  };
}
export async function listPlans(tx: Tx, entityId: string, at: Date, policy: PurchasePolicy) {
  if (policy.mode !== "in_app") return { items: [] };
  const entitlements = await getEntitlements(tx, entityId, at),
    params = await paramsAt(tx, at),
    plans = await tx.plan.findMany({
      where: { isListed: true, scope: "public" },
      orderBy: { rank: "asc" },
    });
  const items = [];
  for (const plan of plans) {
    const revision = await tx.planRevision.findFirst({
      where: { planId: plan.id, effectiveAt: { lte: at }, cancelledAt: null },
      orderBy: [{ effectiveAt: "desc" }, { revisionNo: "desc" }],
    });
    if (revision)
      items.push(
        PlanCardSchema.parse({
          ...benefitsOf(revision),
          planId: plan.id,
          code: plan.code,
          name: plan.name,
          rank: plan.rank,
          isCurrent: entitlements.term?.planId === plan.id,
          planRevisionId: revision.id,
          monthlyFeeFen: revision.monthlyFeeFen,
          cyclePrices: params.enabledCycles.map((months) => ({
            months,
            priceFen:
              (revision.cyclePrices as Record<string, number>)[String(months)] ??
              revision.monthlyFeeFen * months,
          })),
        }),
      );
  }
  return { items };
}
export async function quotePlan(
  tx: Tx,
  entityId: string,
  at: Date,
  input: PlanQuoteBody,
  policy: (type: string, amountFen: number) => Promise<PurchasePolicy>,
) {
  const e = await getEntitlements(tx, entityId, at);
  if (e.refundPending) throw new AppError("PLAN_REFUND_IN_PROGRESS");
  if (
    e.subStatus === "active" ||
    (await tx.subscriptionTerm.count({
      where: { entityId, status: "scheduled", endsAt: { gt: at } },
    })) > 0
  )
    throw new AppError("STATE_NOT_ALLOWED");
  const { plan, revision } = await planAt(tx, input.planId, at),
    params = await paramsAt(tx, at);
  if (input.months === undefined)
    throw new AppError("VALIDATION_FAILED", {
      details: { fieldErrors: [{ path: "months", message: "请选择购买周期" }] },
    });
  if (!params.enabledCycles.includes(input.months))
    throw new AppError("CYCLE_NOT_AVAILABLE", { details: { enabledCycles: params.enabledCycles } });
  let priced = revision,
    promo: null | {
      type: "previous_revision";
      appliedRevisionId: string;
      claimRevisionId: string;
    } = null;
  if (
    (revision.legacyPromo as { type?: string } | null)?.type === "previous_revision" &&
    !(await tx.planPromoClaim.findUnique({
      where: { entityId_planRevisionId: { entityId, planRevisionId: revision.id } },
    }))
  ) {
    const previous = await tx.planRevision.findFirst({
      where: { planId: plan.id, effectiveAt: { lt: revision.effectiveAt }, cancelledAt: null },
      orderBy: { effectiveAt: "desc" },
    });
    if (previous) {
      priced = previous;
      promo = {
        type: "previous_revision",
        appliedRevisionId: previous.id,
        claimRevisionId: revision.id,
      };
    }
  }
  const months = input.months,
    payFen =
      (priced.cyclePrices as Record<string, number>)[String(months)] ??
      priced.monthlyFeeFen * months,
    p = await policy("plan_new", payFen);
  if (p.mode !== "in_app")
    throw new AppError("PURCHASE_NOT_OFFERED", { details: { mode: p.mode } });
  const term = termDates(calendarDate(at), months);
  const quote = PlanQuoteSchema.parse({
    action: "subscribe",
    orderType: "plan_new",
    planId: plan.id,
    planRevisionId: revision.id,
    planName: plan.name,
    fromPlanName: null,
    months,
    payFen,
    formula: formulaOf(priced.monthlyFeeFen, payFen, months),
    effectiveMode: "immediate",
    newTerm: { startDate: term.startDate, endDate: term.endDate },
    firstGrantDate: term.startDate,
    benefits: benefitsOf(revision),
    upgrade: null,
    downgradeImpact: null,
    promo: promo ? { type: promo.type, appliedRevisionId: promo.appliedRevisionId } : null,
    validUntil: null,
    quotedAt: at.toISOString(),
    policy: p,
  });
  return {
    quote,
    content: {
      v: 1,
      kind: "plan" as const,
      planId: plan.id,
      planRevisionId: revision.id,
      months,
      cyclePriceFen: payFen,
      payFen,
      monthlyPoints: revision.monthlyPoints,
      discountBp: revision.discountBp,
      promo,
      quotedAt: at.toISOString(),
    },
  };
}
