import type { DramaPriceRow, DramaPriceRevision, DramaPricing, StaffBrief } from "@liyoxi/contract";
import {
  DramaPriceRowSchema,
  DramaPriceRevisionSchema,
  DramaPricingSchema,
} from "@liyoxi/contract";
import type { DramaPriceRevision as Revision } from "@liyoxi/db";
import { divRoundHalfUp } from "@liyoxi/shared/pricing";
import { calendarDate, addDays } from "@liyoxi/shared/time";
import { hasPermission } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import type { Content } from "../../content/index.js";
import type { Tx } from "../../kernel/index.js";
import { paramsAt as configAt } from "../../config/index.js";
import { priceAt } from "./index.js";
export interface PricingReadDeps {
  content: Pick<Content, "getDramaCards" | "getOrderability">;
  staffBriefs(tx: Tx, ids: readonly string[]): Promise<StaffBrief[]>;
}
export async function currentTiers(tx: Tx, at: Date) {
  const rows = await tx.priceTierRevision.findMany({
    where: { effectiveAt: { lte: at } },
    orderBy: [{ effectiveAt: "desc" }, { id: "asc" }],
  });
  return ["S", "A", "B", "C"].flatMap((tier) => {
    const row = rows.find((v) => v.tier === tier);
    return row ? [row] : [];
  });
}
export function revisionState(row: Revision, at: Date) {
  return row.cancelledAt
    ? ("withdrawn" as const)
    : row.effectiveAt > at
      ? ("pending" as const)
      : ("effective" as const);
}
export async function revisionView(
  tx: Tx,
  deps: PricingReadDeps,
  row: Revision,
  at: Date,
  staff: StaffContext,
): Promise<DramaPriceRevision> {
  const [drama, briefs] = await Promise.all([
    tx.drama.findUniqueOrThrow({ where: { id: row.dramaId }, select: { title: true } }),
    deps.staffBriefs(tx, [row.createdByStaffId]),
  ]);
  const createdBy = briefs[0];
  if (!createdBy) throw new TypeError("调价修订缺少真实员工引用");
  const state = revisionState(row, at);
  return DramaPriceRevisionSchema.parse({
    dramaPriceRevisionId: row.id,
    dramaId: row.dramaId,
    dramaTitle: drama.title,
    mode: row.mode,
    customPoints: row.customPoints,
    prevPoints: row.prevPoints,
    newPoints: row.newPoints,
    effectiveAt: row.effectiveAt.toISOString(),
    reasonCode: row.reasonCode,
    note: row.note,
    state,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    createdBy,
    createdAt: row.createdAt.toISOString(),
    actions: state === "pending" && hasPermission(staff, "billing.price.edit") ? ["withdraw"] : [],
  });
}
export async function priceRows(
  tx: Tx,
  deps: PricingReadDeps,
  staff: StaffContext,
  at: Date,
  ids?: readonly string[],
): Promise<DramaPriceRow[]> {
  const dramaIds = ids ?? (await tx.drama.findMany({ select: { id: true } })).map((v) => v.id);
  const [cards, orderability, prices, tiers, revisions, plans, config] = await Promise.all([
    deps.content.getDramaCards(tx, dramaIds, at),
    deps.content.getOrderability(tx, dramaIds, calendarDate(at)),
    priceAt(tx, dramaIds, at),
    currentTiers(tx, at),
    tx.dramaPriceRevision.findMany({
      where: { dramaId: { in: [...dramaIds] }, cancelledAt: null },
      orderBy: [{ effectiveAt: "desc" }, { id: "asc" }],
    }),
    tx.plan.findMany({
      where: { isListed: true },
      include: {
        planRevisions: {
          where: { effectiveAt: { lte: at }, cancelledAt: null },
          orderBy: { effectiveAt: "desc" },
          take: 1,
        },
      },
      orderBy: [{ rank: "asc" }, { id: "asc" }],
    }),
    configAt(tx, ["remind.copyright.days"], at),
  ]);
  const heatAudits = await tx.auditLog.findMany({
    where: {
      targetType: "drama",
      targetId: { in: [...dramaIds] },
      action: "drama.heat_tier.change",
    },
    orderBy: { createdAt: "desc" },
    select: { targetId: true, createdAt: true },
  });
  const today = calendarDate(at),
    last = addDays(today, config["remind.copyright.days"]);
  return cards.map((card) => {
    const price = prices.get(card.id),
      available = price !== undefined && typeof price === "object" ? price : null;
    const tier = tiers.find((v) => v.tier === card.heatTier),
      current = revisions.find((v) => v.dramaId === card.id && v.effectiveAt <= at),
      pending = revisions.filter((v) => v.dramaId === card.id && v.effectiveAt > at).at(-1);
    const stop = orderability.get(card.id)?.stopDate ?? null,
      end = card.licenseEndDate;
    const licenseFlag =
      end && today > end
        ? "license_ended"
        : card.status === "listed" && stop && today >= stop
          ? "stopped"
          : card.status !== "listed"
            ? "not_listed"
            : "orderable";
    const priceLockReason = card.archivedAt
      ? "archived"
      : licenseFlag === "license_ended"
        ? "license_ended"
        : licenseFlag === "stopped"
          ? "stopped"
          : null;
    const dates = [current?.effectiveAt];
    if (available?.source.mode === "template")
      dates.push(tier?.effectiveAt, heatAudits.find((v) => v.targetId === card.id)?.createdAt);
    const since = dates
      .filter((v): v is Date => v !== undefined)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    return DramaPriceRowSchema.parse({
      dramaId: card.id,
      title: card.title,
      status: card.status,
      archivedAt: card.archivedAt?.toISOString() ?? null,
      heatTier: card.heatTier,
      templatePoints: tier?.points ?? null,
      listPricePoints: available?.points ?? null,
      priceMode: available?.source.mode ?? null,
      currentRevision: current
        ? {
            dramaPriceRevisionId: current.id,
            mode: current.mode,
            reasonCode: current.reasonCode,
            note: current.note,
            effectiveAt: current.effectiveAt.toISOString(),
          }
        : null,
      pricedSince: since?.toISOString() ?? null,
      pendingRevision: pending
        ? {
            dramaPriceRevisionId: pending.id,
            newPoints: pending.newPoints,
            effectiveAt: pending.effectiveAt.toISOString(),
          }
        : null,
      planPrices: plans.flatMap((plan) => {
        const revision = plan.planRevisions[0];
        return revision
          ? [
              {
                planId: plan.id,
                planCode: plan.code,
                planName: plan.name,
                discountBp: revision.discountBp,
                discountedPoints: available
                  ? divRoundHalfUp([available.points, revision.discountBp], [10000])
                  : null,
              },
            ]
          : [];
      }),
      licenseEndDate: end,
      stopOrderDate: stop,
      licenseFlag,
      isExpiringSoon: Boolean(end && end >= today && end <= last),
      canCreatePriceRevision: hasPermission(staff, "billing.price.edit") && !priceLockReason,
      priceLockReason,
    });
  });
}
export async function detailPricing(
  tx: Tx,
  deps: PricingReadDeps,
  staff: StaffContext,
  id: string,
  at: Date,
): Promise<DramaPricing> {
  const row = (await priceRows(tx, deps, staff, at, [id]))[0];
  if (!row) throw new TypeError("剧目缺少价格读模型");
  const [tiers, pending] = await Promise.all([
    currentTiers(tx, at),
    tx.dramaPriceRevision.findMany({
      where: { dramaId: id, effectiveAt: { gt: at }, cancelledAt: null },
      orderBy: [{ effectiveAt: "asc" }, { id: "asc" }],
    }),
  ]);
  const { note: _note, ...current } = row.currentRevision ?? { note: null };
  return DramaPricingSchema.parse({
    listPricePoints: row.listPricePoints,
    priceMode: row.priceMode,
    templatePoints: row.templatePoints,
    currentRevision: row.currentRevision ? current : null,
    pendingRevisions: pending.map((v) => ({
      dramaPriceRevisionId: v.id,
      newPoints: v.newPoints,
      effectiveAt: v.effectiveAt.toISOString(),
    })),
    tierTemplates: tiers.map((v) => ({ tier: v.tier, points: v.points })),
    planPrices: row.planPrices,
  });
}
