import { PlanCardSchema, PlanQuoteSchema } from "@liyoxi/contract";
import type { BillingOrderContent, PlanQuoteBody, PurchasePolicy } from "@liyoxi/contract";
import { termDates, upgradePosition } from "@liyoxi/shared/period";
import { calendarDate } from "@liyoxi/shared/time";
import { quoteUpgrade } from "@liyoxi/shared/pricing";
import { splitEvenly } from "@liyoxi/shared/alloc";
import { paramsAt as configParamsAt } from "../../config/index.js";
import { renewalDates } from "../subscription/terms.js";
import { fromDateColumn } from "../ledger/context.js";
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
  const { plan, revision } = await planAt(tx, input.planId, at),
    params = await paramsAt(tx, at),
    current = e.term
      ? await tx.subscriptionTerm.findUniqueOrThrow({ where: { id: e.term.termId } })
      : null,
    from = current ? await tx.plan.findUniqueOrThrow({ where: { id: current.planId } }) : null;
  const action = !current
    ? "subscribe"
    : plan.rank > from!.rank
      ? input.intent === "renew_next_term"
        ? "renew_upgrade"
        : "upgrade"
      : plan.rank < from!.rank
        ? "downgrade"
        : "renew";
  if (action === "upgrade") {
    const position = upgradePosition(
      {
        startDate: fromDateColumn(current!.startDate),
        endDate: fromDateColumn(current!.endDate),
        anchorDay: current!.anchorDay,
        months: current!.months,
      },
      calendarDate(at),
      params.prorationBaseDays,
    );
    const targetCyclePriceFen = (revision.cyclePrices as Record<string, number>)[
      String(current!.months)
    ];
    if (targetCyclePriceFen === undefined) throw new AppError("PLAN_NOT_AVAILABLE");
    const feeDeltaPerMonthFen =
        splitEvenly(targetCyclePriceFen, current!.months)[0]! - current!.monthlyEquivFen,
      pointsDeltaPerMonth = revision.monthlyPoints - current!.monthlyPoints;
    if (feeDeltaPerMonthFen <= 0 || pointsDeltaPerMonth <= 0)
      throw new AppError("UPGRADE_NOT_ALLOWED_TODAY", { details: { suggest: "renew_next_term" } });
    const result = quoteUpgrade({
      ...position,
      feeDeltaPerMonthFen,
      pointsDeltaPerMonth,
      baseDays: params.prorationBaseDays,
    });
    if (result.payFen <= 0 || (result.topupPoints === 0 && position.remainingFullMonths === 0))
      throw new AppError("UPGRADE_NOT_ALLOWED_TODAY", { details: { suggest: "renew_next_term" } });
    const hours = await configParamsAt(tx, ["billing.upgrade_quote_valid_hours"], at),
      validUntil = new Date(
        Math.min(
          current!.endsAt.getTime(),
          at.getTime() + hours["billing.upgrade_quote_valid_hours"] * 3600000,
        ),
      ).toISOString(),
      p = await policy("plan_upgrade", result.payFen);
    if (p.mode !== "in_app")
      throw new AppError("PURCHASE_NOT_OFFERED", { details: { mode: p.mode } });
    const content = {
      v: 1,
      kind: "upgrade",
      termId: current!.id,
      fromPlanRevisionId: current!.planRevisionId,
      toPlanRevisionId: revision.id,
      quotedAt: at.toISOString(),
      quotedOn: calendarDate(at),
      ...position,
      baseDays: params.prorationBaseDays,
      feeDeltaPerMonthFen,
      pointsDeltaPerMonth,
      ...result,
      validUntil,
    } satisfies BillingOrderContent;
    return {
      content,
      quote: PlanQuoteSchema.parse({
        action,
        orderType: "plan_upgrade",
        planId: plan.id,
        planRevisionId: revision.id,
        planName: plan.name,
        fromPlanName: from!.name,
        months: null,
        payFen: result.payFen,
        formula: {
          code: "plan_upgrade",
          args: {
            feeDeltaPerMonthFen,
            remainingDays: position.remainingDays,
            baseDays: params.prorationBaseDays,
            remainingFullMonths: position.remainingFullMonths,
            payFen: result.payFen,
          },
          text: `升级补差 ${formatMoney(result.payFen)}`,
        },
        effectiveMode: "immediate",
        newTerm: null,
        firstGrantDate: null,
        benefits: benefitsOf(revision),
        upgrade: {
          currentTermEndDate: fromDateColumn(current!.endDate),
          ...position,
          baseDays: params.prorationBaseDays,
          feeDeltaPerMonthFen,
          monthlyDeltaPoints: pointsDeltaPerMonth,
          ...result,
        },
        downgradeImpact: null,
        promo: null,
        validUntil,
        quotedAt: at.toISOString(),
        policy: p,
      }),
    };
  }
  if (input.months === undefined)
    throw new AppError("VALIDATION_FAILED", {
      details: { fieldErrors: [{ path: "months", message: "请选择购买周期" }] },
    });
  if (!params.enabledCycles.includes(input.months))
    throw new AppError("CYCLE_NOT_AVAILABLE", { details: { enabledCycles: params.enabledCycles } });
  // 仅限制新报价；已付款订单仍按冻结快照履约，不反查这个软上限。
  // 到点但尚未advance的scheduled已是当期，不计为未来预约。
  const scheduled = await tx.subscriptionTerm.count({
    where: { entityId, status: "scheduled", startsAt: { gt: at } },
  });
  if ((current !== null || scheduled > 0) && scheduled >= params.maxScheduledTerms)
    throw new AppError("SCHEDULED_TERM_LIMIT", {
      details: { maxScheduledTerms: params.maxScheduledTerms },
    });
  let priced = revision,
    promo: null | {
      type: "previous_revision";
      appliedRevisionId: string;
      claimRevisionId: string;
    } = null;
  if (
    action === "subscribe" &&
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
    p = await policy(current ? "plan_renew" : "plan_new", payFen);
  if (p.mode !== "in_app")
    throw new AppError("PURCHASE_NOT_OFFERED", { details: { mode: p.mode } });
  const tail = current
    ? await tx.subscriptionTerm.findFirst({
        where: { entityId, status: { in: ["active", "scheduled"] }, endsAt: { gt: at } },
        orderBy: [{ endsAt: "desc" }, { id: "desc" }],
      })
    : null;
  const term = tail ? renewalDates(tail, months) : termDates(calendarDate(at), months);
  const downgradeImpact =
    action === "downgrade"
      ? {
          storesToRemove: Math.max(
            0,
            (await tx.store.count({ where: { entityId, lifecycle: "active" } })) -
              revision.maxStores,
          ),
          membersToRemove:
            revision.maxMembers === null
              ? 0
              : Math.max(
                  0,
                  (await tx.entityMember.count({
                    where: { entityId, role: "clerk", status: "active" },
                  })) - revision.maxMembers,
                ),
        }
      : null;
  const quote = PlanQuoteSchema.parse({
    action,
    orderType: current ? "plan_renew" : "plan_new",
    planId: plan.id,
    planRevisionId: revision.id,
    planName: plan.name,
    fromPlanName: from?.name ?? null,
    months,
    payFen,
    formula: formulaOf(priced.monthlyFeeFen, payFen, months),
    effectiveMode: current ? "next_term" : "immediate",
    newTerm: { startDate: term.startDate, endDate: term.endDate },
    firstGrantDate: term.startDate,
    benefits: benefitsOf(revision),
    upgrade: null,
    downgradeImpact,
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
      planName: plan.name,
      planRevisionId: revision.id,
      months,
      cyclePriceFen: payFen,
      payFen,
      monthlyPoints: revision.monthlyPoints,
      discountBp: revision.discountBp,
      promo,
      quotedAt: at.toISOString(),
    } satisfies BillingOrderContent,
  };
}
