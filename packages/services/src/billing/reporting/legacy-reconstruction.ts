import { createHash } from "node:crypto";
import {
  SubscriptionDailySnapshotSchema,
  planOrderContentSchema,
  fulfillDoneSchema,
} from "@liyoxi/contract";
import { splitEvenly } from "@liyoxi/shared/alloc";
import { termDates, grantSchedule } from "@liyoxi/shared/period";
import { calendarDate, endOfDay, startOfDay } from "@liyoxi/shared/time";
import type { LegacyEvidence } from "./legacy-evidence-schema.js";
export const LEGACY_EVENT_ID = "01a208c1-2019-743b-bef2-a9759ad59412";
export const LEGACY_BASELINE_SHA = "6c8a8498ac4540843c7e906157bb336d0438c4a4";
export const LEGACY_RECONSTRUCTION_SOURCE = "13f485def43857afda19dc58303ff687099bb2ca";
export function canonicalLegacyJson(value: unknown): string {
  return JSON.stringify(value, (_key: string, item: unknown) => {
    if (typeof item === "bigint") return item.toString();
    return item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item;
  });
}
export const legacyHash = (value: unknown): string =>
  createHash("sha256").update(canonicalLegacyJson(value)).digest("hex");
function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`LEGACY_RECOVERY_REJECTED:${code}`);
}
const iso = (x: string) => new Date(x).toISOString();
const sameTime = (a: string | null, b: string) =>
  a !== null && Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);
export function reconstructLegacySnapshot(f: LegacyEvidence) {
  check(
    f.sourceSha === LEGACY_RECONSTRUCTION_SOURCE && f.baselineSha === LEGACY_BASELINE_SHA,
    "source_identity",
  );
  check(
    [...f.events, ...f.operations, ...f.entries, ...f.activationOutbox].every((r) =>
      typeof r.seq === "string" ? /^[0-9]+$/.test(r.seq) : Number.isSafeInteger(r.seq),
    ),
    "sequence_precision",
  );
  const e = f.event;
  check(
    e.id === LEGACY_EVENT_ID && e.type === "activated" && e.payload === null,
    "exact_null_activated",
  );
  check(
    f.events.length === 1 && canonicalLegacyJson(f.events[0]) === canonicalLegacyJson(e),
    "other_subscription_history",
  );
  check(f.terms.length === 1, "term_count");
  const t = f.terms[0]!;
  check(
    t.id === e.subscription_term_id && t.entity_id === e.entity_id && f.entity.id === e.entity_id,
    "entity_term_scope",
  );
  check(
    t.origin === "new" && t.term_no === 1 && t.status === "active",
    "unsupported_term_lifecycle",
  );
  check(
    t.extended_days === 0 &&
      t.refund_request_id === null &&
      t.refund_rule === null &&
      t.ended_at === null &&
      t.refunded_at === null,
    "term_lifecycle_changed",
  );
  check(
    f.guardCounts.refundRequests === 0 &&
      f.guardCounts.refundTxns === 0 &&
      f.guardCounts.extensions === 0,
    "refund_or_extension_exists",
  );
  check(
    f.account.entity_id === e.entity_id &&
      f.account.current_subscription_term_id === t.id &&
      f.account.sub_status === "active",
    "account_scope",
  );
  check(f.orders.filter((x) => x.type !== "topup").length === 1, "other_plan_order");
  const o = f.orders.find((x) => x.id === e.billing_order_id);
  check(o && o.id === t.source_billing_order_id && o.entity_id === e.entity_id, "order_scope");
  check(
    o.type === "plan_new" &&
      o.status === "paid" &&
      o.source === "weapp" &&
      o.channel === "bank_transfer" &&
      o.fulfillment_status === "done" &&
      o.refunded_amount_fen === 0,
    "order_state",
  );
  const content = planOrderContentSchema.parse(o.content_snapshot);
  const done = fulfillDoneSchema.parse(o.fulfillment_result);
  check(
    done.termId === t.id && done.queuedBehindActive === false && done.lotIds.length === 1,
    "fulfillment_result",
  );
  check(
    content.planId === e.to_plan_id &&
      content.planRevisionId === e.to_plan_revision_id &&
      content.planId === t.plan_id &&
      content.planRevisionId === t.plan_revision_id &&
      content.planRevisionId === t.initial_plan_revision_id,
    "original_plan_identity",
  );
  check(e.from_plan_id === null && e.from_plan_revision_id === null, "unexpected_from_plan");
  check(
    content.months === t.months &&
      content.payFen === o.amount_fen &&
      content.payFen === o.paid_amount_fen &&
      content.payFen === t.price_total_fen &&
      content.monthlyPoints === t.monthly_points &&
      content.discountBp === t.discount_bp,
    "order_term_values",
  );
  const p = f.payments.find((x) => x.id === o.paid_payment_txn_id);
  check(
    p &&
      p.entity_id === e.entity_id &&
      p.billing_order_id === o.id &&
      p.status === "succeeded" &&
      p.channel === o.channel &&
      p.amount_fen === content.payFen &&
      p.channel_amount_fen === content.payFen &&
      p.refunded_fen === 0 &&
      p.applied_at !== null,
    "paid_receipt",
  );
  const start = iso(e.occurred_at),
    day = calendarDate(new Date(start));
  check(
    e.biz_date === day &&
      sameTime(e.created_at, start) &&
      [
        t.created_at,
        t.updated_at,
        t.starts_at,
        t.activated_at,
        o.fulfilled_at,
        done.effectiveAt,
      ].every((x) => sameTime(x, start)),
    "activation_time_evidence",
  );
  const dates = termDates(day, content.months);
  const end = endOfDay(dates.endDate).toISOString();
  check(
    t.start_date === dates.startDate &&
      t.end_date === dates.endDate &&
      t.anchor_day === dates.anchorDay &&
      sameTime(t.ends_at, end),
    "initial_period",
  );
  check(f.activationOutbox.length === 1, "original_outbox_required");
  const x = f.activationOutbox[0]!,
    xp = x.payload;
  check(
    x.entity_id === e.entity_id &&
      x.aggregate_type === "subscription_term" &&
      x.aggregate_id === t.id &&
      x.event_type === "billing.subscription.activated" &&
      x.dedupe_key === `billing.subscription.activated:${t.id}`,
    "outbox_identity",
  );
  check(
    xp.v === 1 &&
      xp.entityId === e.entity_id &&
      xp.termId === t.id &&
      xp.planId === content.planId &&
      xp.sourceBillingOrderId === o.id &&
      sameTime(xp.startsAt, start) &&
      sameTime(xp.endsAt, end),
    "immutable_original_span",
  );
  check(
    Date.parse(x.created_at) <= Date.parse(start) &&
      Date.parse(start) <= Date.parse(x.occurred_at) &&
      Date.parse(p.channel_success_at) <= Date.parse(p.applied_at) &&
      Date.parse(p.applied_at) <= Date.parse(start) &&
      Date.parse(o.applied_at) <= Date.parse(start),
    "transaction_time_chain",
  );
  const rows = grantSchedule(dates, {
    monthlyPoints: content.monthlyPoints,
    payFen: content.payFen,
  });
  check(
    f.grants.length === rows.length &&
      new Set(f.grants.map((g) => g.id)).size === rows.length &&
      new Set(f.grants.map((g) => g.month_no)).size === rows.length,
    "grant_coverage",
  );
  const grants = [...f.grants].sort((a, b) => a.month_no - b.month_no);
  for (const [i, g] of grants.entries()) {
    const r = rows[i]!;
    check(
      g.month_no === i &&
        g.subscription_term_id === t.id &&
        g.entity_id === e.entity_id &&
        g.plan_id === content.planId &&
        g.plan_revision_id === content.planRevisionId,
      "grant_scope",
    );
    const due = i === 0 ? start : startOfDay(r.dueDate).toISOString();
    check(
      g.due_date === r.dueDate &&
        sameTime(g.due_at, due) &&
        g.points === r.points &&
        g.value_fen === r.valueFen &&
        sameTime(g.created_at, start) &&
        sameTime(g.updated_at, start),
      "original_grant_values",
    );
    if (i === 0)
      check(
        g.status === "granted" &&
          sameTime(g.granted_at, start) &&
          g.point_lot_id === done.lotIds[0],
        "first_grant_not_proven",
      );
    else
      check(
        g.status === "pending" &&
          g.granted_at === null &&
          g.point_lot_id === null &&
          Date.parse(g.due_at) > Date.parse(start),
        "future_grant_changed",
      );
  }
  const first = grants[0]!,
    planLots = f.lots.filter((l) => l.subscription_term_id === t.id);
  check(planLots.length === 1, "unexpected_term_lots");
  const lot = planLots[0]!;
  check(
    lot.id === first.point_lot_id &&
      lot.entity_id === e.entity_id &&
      lot.kind === "plan" &&
      lot.source_type === "grant_monthly" &&
      lot.source_id === first.id &&
      lot.source_no === 0 &&
      lot.plan_id === content.planId &&
      lot.plan_revision_id === content.planRevisionId &&
      lot.original_qty === first.points &&
      lot.cost_basis_fen === first.value_fen &&
      sameTime(lot.granted_at, start) &&
      sameTime(lot.expires_at, end),
    "first_month_lot",
  );
  const op = f.operations.find((v) => v.op_key === `grant:grant_schedule:${first.id}`),
    fulfill = f.operations.find((v) => v.op_key === `fulfill:billing_order:${o.id}`);
  check(
    op &&
      fulfill &&
      op.op_type === "grant" &&
      op.ref_type === "grant_schedule" &&
      op.ref_id === first.id &&
      fulfill.op_type === "fulfill" &&
      fulfill.ref_type === "billing_order" &&
      fulfill.ref_id === o.id &&
      [op, fulfill].every(
        (v) => v.entity_id === e.entity_id && v.biz_date === day && sameTime(v.occurred_at, start),
      ) &&
      BigInt(op.seq) < BigInt(fulfill.seq),
    "grant_fulfill_operations",
  );
  const inflows = f.entries.filter(
    (v) => v.point_lot_id === lot.id && v.from_bucket === "external" && v.to_bucket === "available",
  );
  check(inflows.length === 1, "first_month_inflow_count");
  const inflow = inflows[0]!;
  check(
    inflow.entity_id === e.entity_id &&
      inflow.ledger_operation_id === op.id &&
      inflow.lot_kind === "plan" &&
      inflow.plan_id === content.planId &&
      inflow.qty === first.points &&
      sameTime(inflow.occurred_at, start) &&
      inflow.biz_date === day,
    "first_month_ledger",
  );
  check(
    !f.operations.some((v) =>
      ["extend", "revoke", "refund", "refund_suspend", "refund_resume", "fix"].includes(v.op_type),
    ),
    "other_mutation_operations",
  );
  const monthlyEquiv = splitEvenly(content.payFen, content.months)[0];
  check(monthlyEquiv === t.monthly_equiv_fen, "monthly_equiv");
  return {
    dailySnapshot: SubscriptionDailySnapshotSchema.parse({
      v: 1,
      termId: e.subscription_term_id,
      status: "active",
      planId: e.to_plan_id,
      planRevisionId: e.to_plan_revision_id,
      months: content.months,
      monthlyEquivFen: monthlyEquiv,
      startsAt: iso(xp.startsAt),
      endsAt: iso(xp.endsAt),
      activatedAt: start,
      pendingGrants: grants.slice(1).map((g, i) => ({
        grantScheduleId: g.id,
        monthNo: rows[i + 1]!.monthNo,
        dueDate: rows[i + 1]!.dueDate,
        valueFen: rows[i + 1]!.valueFen,
      })),
    }),
  };
}
