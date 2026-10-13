import type { BillingOrder, SubscriptionTerm } from "@liyoxi/db";
import type { StoreRow } from "@liyoxi/contract";
import { calendarDate, diffDays } from "@liyoxi/shared/time";
import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { StoreListBillingFact, StoreListBillingSelection } from "../../profile/index.js";
import { entitlementsOf, walletPointsOf } from "./index.js";
import { paymentContent, renderPaymentTitle } from "./tenant-admin.js";

/** 候选IDs只来自调用方已裁剪的store查询，不扫全库；权益按去重主体计算一次。 */
export async function readProfileStoreListBilling(
  tx: Tx,
  q: { readonly entityIds: readonly string[]; readonly now: Date },
): Promise<StoreListBillingSelection> {
  const ids = [...new Set(q.entityIds)];
  if (!ids.length)
    return {
      facts: new Map(),
      async readRows(rowTx, entityIds) {
        if (rowTx !== tx || entityIds.length) throw new TypeError("分页主体须属于本次空候选集");
        return new Map();
      },
    };
  const [terms, accounts, paid] = await Promise.all([
    tx.subscriptionTerm.findMany({
      where: { entityId: { in: ids }, status: { in: ["scheduled", "active", "ended"] } },
      orderBy: { startsAt: "asc" },
    }),
    tx.billingAccount.findMany({
      where: { entityId: { in: ids } },
      select: { entityId: true, lastExpiredQty: true, lastExpiredAt: true },
    }),
    tx.billingOrder.groupBy({
      by: ["entityId", "status"],
      where: { entityId: { in: ids }, status: { in: ["paid", "refunded"] } },
      _sum: { paidAmountFen: true, refundedAmountFen: true },
      _count: { _all: true },
    }),
  ]);
  const termsBy = new Map<string, SubscriptionTerm[]>(ids.map((id) => [id, []]));
  for (const term of terms) termsBy.get(term.entityId)!.push(term);
  const entitlements = new Map(ids.map((id) => [id, entitlementsOf(termsBy.get(id)!, q.now)]));
  const accountBy = new Map(accounts.map((row) => [row.entityId, row]));
  const net = new Map<string, number>(),
    hasPaid = new Set<string>();
  for (const row of paid) {
    net.set(
      row.entityId,
      (net.get(row.entityId) ?? 0) +
        (row._sum.paidAmountFen ?? 0) -
        (row._sum.refundedAmountFen ?? 0),
    );
    if (row.status === "paid" && row._count._all > 0) hasPaid.add(row.entityId);
  }
  const facts = new Map<string, StoreListBillingFact>();
  for (const id of ids) {
    if (!accountBy.has(id)) throw new AppError("INTERNAL", { message: "商家主体缺少计费账户" });
    const e = entitlements.get(id)!;
    facts.set(id, {
      status: e.subStatus,
      activePlanId: e.term?.planId ?? null,
      remainingDays: e.term ? diffDays(e.term.endDate, calendarDate(q.now)) : null,
      totalPaidFen: net.get(id) ?? 0,
      hasPaidOrder: hasPaid.has(id),
    });
  }
  return {
    facts,
    async readRows(rowTx, entityIds) {
      if (rowTx !== tx) throw new TypeError("列表投影必须使用同一次调用方事务");
      const pageIds = [...new Set(entityIds)];
      if (pageIds.some((id) => !facts.has(id))) throw new TypeError("分页主体须属于已裁剪候选集");
      if (!pageIds.length) return new Map();
      const subjects = pageIds.map((id) => ({
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
        SELECT s.entity_id::text,
          COALESCE(sum(p.available_qty) FILTER (WHERE p.kind='plan' AND p.subscription_term_id=s.term_id AND p.expires_at>${q.now}),0)::int AS plan_available,
          COALESCE(sum(p.original_qty) FILTER (WHERE p.kind='plan' AND p.subscription_term_id=s.term_id),0)::int AS plan_granted,
          COALESCE(sum(p.available_qty) FILTER (WHERE p.kind='addon'),0)::int AS addon_available,
          COALESCE(sum(p.held_qty),0)::int AS held
        FROM subjects s LEFT JOIN point_lot p ON p.entity_id=s.entity_id GROUP BY s.entity_id`;
      type Payment = Pick<
        BillingOrder,
        "id" | "entityId" | "orderNo" | "type" | "status" | "contentSnapshot" | "refundedAt"
      >;
      const nonActive = pageIds.filter((id) => entitlements.get(id)!.subStatus !== "active");
      const latest = nonActive.length
        ? await tx.$queryRaw<Payment[]>`
        SELECT DISTINCT ON (entity_id) id,entity_id AS "entityId",order_no AS "orderNo",type,status,content_snapshot AS "contentSnapshot",refunded_at AS "refundedAt"
        FROM billing_order WHERE entity_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(nonActive)}::jsonb) AS e(value))
        ORDER BY entity_id,created_at DESC,id DESC`
        : [];
      const payments = latest.map((row) => ({
        row,
        content: paymentContent(row.type, row.contentSnapshot),
      }));
      const revisionIds = payments.flatMap(({ content }) =>
        content.kind === "upgrade" ? [content.toPlanRevisionId] : [],
      );
      const revisions = revisionIds.length
        ? await tx.planRevision.findMany({
            where: { id: { in: revisionIds } },
            select: { id: true, planId: true },
          })
        : [];
      const revisionBy = new Map(revisions.map((r) => [r.id, r.planId]));
      const paymentPlanId = (content: ReturnType<typeof paymentContent>) => {
        if (content.kind === "topup") return undefined;
        if (content.kind !== "upgrade") return content.planId;
        const id = revisionBy.get(content.toPlanRevisionId);
        if (!id) throw new AppError("INTERNAL");
        return id;
      };
      const planIds = new Set<string>();
      for (const id of pageIds) {
        const e = entitlements.get(id)!,
          shown = e.term ?? e.lastTerm;
        if (shown) planIds.add(shown.planId);
      }
      for (const { content } of payments) {
        const id = paymentPlanId(content);
        if (id) planIds.add(id);
      }
      const plans = planIds.size
        ? await tx.plan.findMany({
            where: { id: { in: [...planIds] } },
            select: { id: true, code: true, name: true },
          })
        : [];
      const planBy = new Map(plans.map((p) => [p.id, p]));
      const paymentBy = new Map(payments.map((p) => [p.row.entityId, p]));
      const sumsBy = new Map(sums.map((s) => [s.entity_id, s]));
      const rows = new Map<string, Pick<StoreRow, "subscription" | "points">>();
      for (const id of pageIds) {
        const e = entitlements.get(id)!,
          shown = e.term ?? e.lastTerm,
          plan = shown ? planBy.get(shown.planId) : null;
        if (shown && !plan) throw new AppError("INTERNAL");
        const payment = paymentBy.get(id);
        let latestPaymentOrder: StoreRow["subscription"]["latestPaymentOrder"] = null;
        if (payment) {
          const { row, content } = payment,
            planId = paymentPlanId(content);
          latestPaymentOrder = {
            paymentOrderId: row.id,
            orderNo: row.orderNo,
            type: row.type,
            status: row.status,
            title: renderPaymentTitle(
              row.type,
              content,
              planId ? planBy.get(planId)?.name : undefined,
            ),
            refundedAt: row.refundedAt?.toISOString() ?? null,
          };
        }
        rows.set(id, {
          subscription: {
            status: e.subStatus,
            plan: plan ? { planId: plan.id, code: plan.code, name: plan.name } : null,
            months: shown?.months ?? null,
            startDate: shown?.startDate ?? null,
            endDate: shown?.endDate ?? null,
            hasScheduledTerm: termsBy.get(id)!.some((term) => term.status === "scheduled"),
            isRefundPending: e.refundPending,
            latestPaymentOrder,
          },
          points: walletPointsOf(e, sumsBy.get(id), accountBy.get(id)!),
        });
      }
      return rows;
    },
  };
}
