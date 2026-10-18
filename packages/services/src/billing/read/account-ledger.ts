import {
  PointAccountRowSchema,
  PointAccountDetailSchema,
  PointAccountSummarySchema,
} from "@liyoxi/contract";
import type {
  PointAccountFilter,
  PointAccountListQuery,
  AccountLedgerQuery,
  MerchantLedgerQuery,
} from "@liyoxi/contract";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { byEntity, hasPermission, satisfiesLevel } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { BillingAdjustmentDeps } from "../adjustments/context.js";
import type { PurchaseActor } from "../payment/purchase-context.js";
import { adjustmentAccountInScope } from "../adjustments/context.js";
import { entitlementsOf, walletPointsOf, getWalletView } from "./index.js";
import { entityRef } from "../payment/purchase-read.js";
import { fromDateColumn, toDateColumn } from "../ledger/context.js";
import { adminLedgerPage, merchantLedgerPage } from "./ledger-rows.js";

const view = (staff: StaffContext) => {
  if (!satisfiesLevel(staff.moduleLevels.billing, "view")) throw new AppError("PERMISSION_DENIED");
};
export function createBillingAccounts(deps: BillingAdjustmentDeps) {
  async function candidates(
    tx: Tx,
    staff: StaffContext,
    query: PointAccountFilter,
    at: Date,
    entityId?: string,
  ) {
    const accounts = await tx.billingAccount.findMany({
      where: {
        ...(entityId ? { entityId } : {}),
        AND: [
          byEntity(staff.scope),
          ...(query.q
            ? [
                {
                  entity: {
                    OR: [
                      { name: { contains: query.q, mode: "insensitive" as const } },
                      {
                        stores: {
                          some: { name: { contains: query.q, mode: "insensitive" as const } },
                        },
                      },
                    ],
                  },
                },
              ]
            : []),
        ],
      },
      select: { entityId: true, updatedAt: true, lastExpiredQty: true, lastExpiredAt: true },
    });
    if (!accounts.length) return [];
    const ids = accounts.map((row) => row.entityId),
      terms = await tx.subscriptionTerm.findMany({
        where: { entityId: { in: ids }, status: { in: ["scheduled", "active", "ended"] } },
        include: { plan: true },
        orderBy: { startsAt: "asc" },
      }),
      grouped = new Map(ids.map((id) => [id, terms.filter((row) => row.entityId === id)])),
      entitlements = new Map(ids.map((id) => [id, entitlementsOf(grouped.get(id)!, at)])),
      subjects = ids.map((id) => ({
        entity_id: id,
        term_id: entitlements.get(id)!.term?.termId ?? null,
      }));
    const sums = await tx.$queryRaw<
      {
        entity_id: string;
        plan_available: number;
        plan_granted: number;
        addon_available: number;
        held: number;
      }[]
    >`
      WITH subjects AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(subjects)}::jsonb) AS s(entity_id uuid,term_id uuid))
      SELECT s.entity_id::text, COALESCE(sum(p.available_qty) FILTER (WHERE p.kind='plan' AND p.subscription_term_id=s.term_id AND p.expires_at>${at}),0)::int AS plan_available,
        COALESCE(sum(p.original_qty) FILTER (WHERE p.kind='plan' AND p.subscription_term_id=s.term_id),0)::int AS plan_granted,
        COALESCE(sum(p.available_qty) FILTER (WHERE p.kind='addon'),0)::int AS addon_available,
        COALESCE(sum(p.held_qty),0)::int AS held
      FROM subjects s LEFT JOIN point_lot p ON p.entity_id=s.entity_id GROUP BY s.entity_id`;
    const byId = new Map(sums.map((row) => [row.entity_id, row])),
      today = calendarDate(at);
    return accounts
      .map((account) => {
        const e = entitlements.get(account.entityId)!,
          p = walletPointsOf(e, byId.get(account.entityId), account),
          shown = e.term ?? e.lastTerm,
          term = grouped.get(account.entityId)!.find((row) => row.id === shown?.termId) ?? null;
        return { account, e, p, term };
      })
      .filter(
        ({ e, p }) =>
          (!query.planId || e.term?.planId === query.planId) &&
          (!query.subStatus || query.subStatus === e.subStatus) &&
          (!query.flag ||
            (query.flag === "has_held"
              ? p.heldPoints > 0
              : query.flag === "refund_pending"
                ? e.refundPending
                : !!e.term && e.term.endDate >= today && e.term.endDate <= addDays(today, 6))),
      );
  }
  type Candidate = Awaited<ReturnType<typeof candidates>>[number];
  async function row(tx: Tx, candidate: Candidate) {
    const { account: a, e, p, term } = candidate,
      upgrade = term
        ? await tx.subscriptionEvent.findFirst({
            where: { subscriptionTermId: term.id, entityId: a.entityId, type: "upgraded" },
            include: { fromPlan: true },
            orderBy: { seq: "desc" },
          })
        : null,
      pending = await tx.pointAdjustmentRequest.findFirst({
        where: { entityId: a.entityId, approvalRequest: { status: "pending" } },
        select: { id: true },
      });
    return PointAccountRowSchema.parse({
      pointAccountId: a.entityId,
      entity: await entityRef(tx, a.entityId),
      subscription: {
        status: e.subStatus,
        plan: term ? { planId: term.planId, name: term.plan.name } : null,
        months: term?.months ?? null,
        startDate: term ? fromDateColumn(term.startDate) : null,
        endDate: term ? fromDateColumn(term.endDate) : null,
        endsAt: term?.endsAt.toISOString() ?? null,
        upgradedFrom: upgrade?.fromPlan
          ? { planName: upgrade.fromPlan.name, at: upgrade.occurredAt.toISOString() }
          : null,
      },
      planAvailablePoints: p.planAvailablePoints,
      planPointsExpireAt: p.planPointsExpireAt?.toISOString() ?? null,
      addonAvailablePoints: p.addonAvailablePoints,
      isAddonSuspended: p.isAddonSuspended,
      heldPoints: p.heldPoints,
      spendablePoints: p.spendablePoints,
      isRefundPending: e.refundPending,
      hasPendingAdjustment: pending !== null,
    });
  }
  return {
    list: (staff: StaffContext, query: PointAccountListQuery) => {
      view(staff);
      return deps.tx.run(async (tx) => {
        const all = await candidates(tx, staff, query, deps.clock.now());
        all.sort(
          (a, b) =>
            (query.sort === "-spendablePoints"
              ? b.p.spendablePoints - a.p.spendablePoints
              : query.sort === "planPointsExpireAt"
                ? (a.p.planPointsExpireAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
                  (b.p.planPointsExpireAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
                : b.account.updatedAt.getTime() - a.account.updatedAt.getTime()) ||
            a.account.entityId.localeCompare(b.account.entityId),
        );
        return {
          items: await Promise.all(
            all
              .slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
              .map((candidate) => row(tx, candidate)),
          ),
          page: query.page,
          pageSize: query.pageSize,
          total: all.length,
        };
      });
    },
    summary: (staff: StaffContext, query: PointAccountFilter) => {
      view(staff);
      return deps.tx.run(async (tx) => {
        const at = deps.clock.now(),
          all = await candidates(tx, staff, query, at),
          ids = all.map((candidate) => candidate.account.entityId),
          month = calendarDate(at).slice(0, 7),
          start = toDateColumn(`${month}-01`),
          next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)),
          [grants, consumed] = await Promise.all([
            tx.pointLedgerEntry.aggregate({
              where: {
                entityId: { in: ids },
                bizDate: { gte: start, lt: next },
                fromBucket: "external",
                toBucket: "available",
                pointLot: { sourceType: { in: ["grant_monthly", "grant_upgrade"] } },
              },
              _sum: { qty: true },
            }),
            tx.pointLedgerEntry.aggregate({
              where: {
                entityId: { in: ids },
                bizDate: { gte: start, lt: next },
                fromBucket: "held",
                toBucket: "consumed",
              },
              _sum: { qty: true },
            }),
          ]);
        return PointAccountSummarySchema.parse({
          accountCount: all.length,
          activeAccountCount: all.filter(({ e }) => e.subStatus === "active").length,
          balancePoints: all.reduce(
            (sum, { p }) => sum + p.planAvailablePoints + p.addonAvailablePoints + p.heldPoints,
            0,
          ),
          heldPoints: all.reduce((sum, { p }) => sum + p.heldPoints, 0),
          grantedThisMonthPoints: grants._sum.qty ?? 0,
          consumedThisMonthPoints: consumed._sum.qty ?? 0,
        });
      });
    },
    get: (staff: StaffContext, entityId: string) => {
      view(staff);
      return deps.tx.run(async (tx) => {
        await adjustmentAccountInScope(tx, staff, entityId);
        const at = deps.clock.now(),
          list = await candidates(tx, staff, {}, at, entityId),
          candidate = list[0];
        if (!candidate) throw new AppError("NOT_FOUND");
        const base = await row(tx, candidate),
          wallet = await getWalletView(tx, entityId, at),
          current = candidate.e.term
            ? await tx.subscriptionTerm.findUniqueOrThrow({
                where: { id: candidate.e.term.termId },
                include: { plan: true },
              })
            : null,
          [scheduled, adjustment, extension, refund, holds, pendingCancels] = await Promise.all([
            tx.subscriptionTerm.findMany({
              where: { entityId, status: "scheduled", startsAt: { gt: at } },
              include: { plan: true },
              orderBy: { startsAt: "asc" },
              take: 100,
            }),
            tx.pointAdjustmentRequest.findFirst({
              where: { entityId, approvalRequest: { status: "pending" } },
              include: { approvalRequest: true },
            }),
            tx.termExtensionRequest.findFirst({
              where: { entityId, approvalRequest: { status: "pending" } },
              include: { approvalRequest: true },
            }),
            tx.refundRequest.findFirst({
              where: {
                entityId,
                subscriptionTerms: { some: { entityId, status: { in: ["scheduled", "active"] } } },
              },
              include: { approvalRequest: true },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            }),
            tx.pointHold.findMany({
              where: {
                entityId,
                status: "held",
                purpose: "order_item",
                store: { qualificationStatus: "pending" },
              },
              select: {
                id: true,
                groupRef: true,
                qty: true,
                store: { select: { id: true, name: true } },
              },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              take: 100,
            }),
            deps.pendingCancels(tx, entityId),
          ]);
        return PointAccountDetailSchema.parse({
          ...base,
          currentTerm: current
            ? {
                subscriptionTermId: current.id,
                termNo: current.termNo,
                planName: current.plan.name,
                months: current.months,
                startDate: fromDateColumn(current.startDate),
                endDate: fromDateColumn(current.endDate),
                endsAt: current.endsAt.toISOString(),
                extendedDays: current.extendedDays,
                benefits: {
                  discountBp: current.discountBp,
                  monthlyPoints: current.monthlyPoints,
                  productionModel: current.productionModel,
                  maxStores: current.maxStores,
                  maxMembers: current.maxMembers,
                },
              }
            : null,
          scheduledTerms: scheduled.map((t) => ({
            subscriptionTermId: t.id,
            planName: t.plan.name,
            months: t.months,
            startDate: fromDateColumn(t.startDate),
            endDate: fromDateColumn(t.endDate),
          })),
          planGrantedThisTerm: wallet.points.planGrantedThisTermPoints,
          lastExpired: wallet.points.lastExpired
            ? {
                points: wallet.points.lastExpired.expiredPoints,
                at: wallet.points.lastExpired.expiredAt.toISOString(),
              }
            : null,
          notices: {
            pendingRefund: refund
              ? {
                  refundRequestId: refund.id,
                  requestNo: refund.approvalRequest.requestNo,
                  status: refund.status,
                }
              : null,
            pendingAdjustment: adjustment
              ? {
                  pointAdjustmentRequestId: adjustment.id,
                  requestNo: adjustment.approvalRequest.requestNo,
                  direction: adjustment.direction,
                  lotKind: adjustment.lotKind,
                  adjustPoints: adjustment.adjustPoints,
                }
              : null,
            pendingExtension: extension
              ? {
                  termExtensionRequestId: extension.id,
                  requestNo: extension.approvalRequest.requestNo,
                  days: extension.days,
                }
              : null,
            pendingCancels,
            heldAwaitingQualification: holds.map((hold) => ({
              pointHoldId: hold.id,
              groupRef: hold.groupRef,
              qty: hold.qty,
              store: { storeId: hold.store.id, name: hold.store.name },
            })),
          },
          actions:
            hasPermission(staff, "billing.adjust.request") &&
            base.subscription.status === "active" &&
            !base.hasPendingAdjustment
              ? ["create-point-adjustment-request"]
              : [],
        });
      });
    },
    adminLedger: (staff: StaffContext, entityId: string, query: AccountLedgerQuery) => {
      view(staff);
      return deps.tx.run(async (tx) => {
        await adjustmentAccountInScope(tx, staff, entityId);
        return adminLedgerPage(tx, entityId, query, deps.clock.now());
      });
    },
    merchantLedger: (actor: PurchaseActor, query: MerchantLedgerQuery) =>
      deps.tx.run((tx) =>
        merchantLedgerPage(tx, actor.membership.entityId, query, deps.clock.now()),
      ),
  };
}
