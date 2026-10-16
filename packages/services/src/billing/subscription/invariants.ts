// billing 的不变量：订阅一侧的三条——billing.I9、I10、I12（W1-11a）。
// 依据：07 分组 第 2.8、2.9、2.11、5.6 节；D1 第 9 节。写法、调度、不自愈同账户与批次的七条（../invariants.ts）。
// I10 是“周期不重叠”的第二道防线（第一道是建周期时的服务层校验），库里的排他约束在不在都成立。
// I12核套餐与正式升级资金、发放/未发放权益成本；已退款的收回规则由退款域接续。
// 受阻的付款单有没有未决差异单、受阻多久，归付款一侧的 payment.I4。
import { invariantNow } from "../../kernel/index.js";
import type { InvariantRegistration, InvariantViolation, Tx } from "../../kernel/index.js";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { computeEntityValuation } from "../reporting/valuation.js";
import { computeEntityDaily, BillingDailyHistoryMissingError } from "../reporting/daily.js";
import { isNotBlockage } from "./blocked.js";
import { fromDateColumn, toDateColumn } from "../ledger/context.js";
import { check } from "../invariants.js";

/** “到点了还没做”的宽限，同 I6、I8：扫描每分钟一轮，过 10 分钟仍没推进才算 */
const LAG = "interval '10 minutes'";

/**
 * billing.I9：每个主体至多一个生效周期；sub_status = active ⇔ 有一个生效周期、已到起点、还没过止点，
 * 且账户的当前周期指的就是它。
 */
const i9 = check(
  "billing.I9",
  "P2",
  `SELECT 'billing_account' AS subject_type, a.entity_id AS subject_id, a.entity_id,
          jsonb_build_object('subStatus', a.sub_status, 'activeTerms', t.active_terms,
                             'inForce', t.in_force, 'currentIsActive', t.current_is_active) AS detail
     FROM billing_account a
     CROSS JOIN LATERAL (
       SELECT count(*)::int AS active_terms,
              (count(*) FILTER (WHERE s.starts_at <= $2::timestamptz
                                  AND s.ends_at > $2::timestamptz - ${LAG}))::int AS in_force,
              COALESCE(bool_or(s.id = a.current_subscription_term_id), false) AS current_is_active
         FROM subscription_term s
        WHERE s.entity_id = a.entity_id AND s.status = 'active') t
    WHERE t.active_terms > 1
       OR (a.sub_status = 'active' AND (t.in_force <> 1 OR NOT t.current_is_active))
       OR (a.sub_status <> 'active' AND t.active_terms > 0)`,
);

/**
 * billing.I10：同一主体预约、生效、已到期的周期两两不重叠（报在起点较晚的那一个上）；
 * 预约周期首尾相接：它的起点是同主体另一个生效或预约周期的止点。
 */
const i10 = check(
  "billing.I10",
  "P2",
  `SELECT DISTINCT ON (b.id) 'subscription_term' AS subject_type, b.id AS subject_id, b.entity_id,
          jsonb_build_object('problem', 'overlap', 'otherTermId', a.id,
                             'startsAt', b.starts_at, 'otherEndsAt', a.ends_at) AS detail
     FROM subscription_term a
     JOIN subscription_term b
       ON b.entity_id = a.entity_id AND b.id <> a.id
      AND (a.starts_at, a.id) < (b.starts_at, b.id)
      AND b.starts_at < a.ends_at
    WHERE a.status IN ('scheduled', 'active', 'ended') AND b.status IN ('scheduled', 'active', 'ended')
    UNION ALL
   SELECT 'subscription_term', s.id, s.entity_id,
          jsonb_build_object('problem', 'gap', 'startsAt', s.starts_at)
     FROM subscription_term s
    WHERE s.status = 'scheduled'
      AND NOT EXISTS (
        SELECT 1 FROM subscription_term p
         WHERE p.entity_id = s.entity_id AND p.id <> s.id
           AND p.status IN ('scheduled', 'active') AND p.ends_at = s.starts_at)`,
);

/**
 * billing.I12：钱与权益一一对应。履约完成的套餐付款单恰有一个周期，它的发放计划各行分摊之和 = 实付
 * 加上本期正式升级款后，与已发批次及未发计划成本之和相等；已发月份仍逐行核成本；
 * 履约完成的加购付款单恰有一个批次，入账成本 = 实付。
 */
const i12 = check(
  "billing.I12",
  "P1",
  `SELECT 'billing_order' AS subject_type, o.id AS subject_id, o.entity_id,
          jsonb_build_object('problem', CASE WHEN t.terms <> 1 THEN 'term_count'
                                           WHEN t.value_fen <> o.paid_amount_fen + t.upgrade_fen THEN 'schedule_value'
                                           ELSE 'issued_lot_cost' END,
                             'terms', t.terms, 'paidAmountFen', o.paid_amount_fen,
                             'scheduleValueFen', t.value_fen, 'settledValueFen', t.settled_value_fen,
                             'upgradeFen', t.upgrade_fen,
                             'issuedLotMismatches', t.issued_lot_mismatches) AS detail
     FROM billing_order o
     CROSS JOIN LATERAL (
       SELECT count(*)::int AS terms,
              COALESCE(sum(g.value_fen + u.lot_fen), 0)::bigint AS value_fen,
              COALESCE(sum(g.settled_value_fen + u.lot_fen), 0)::bigint AS settled_value_fen,
              COALESCE(sum(u.paid_fen), 0)::bigint AS upgrade_fen,
              COALESCE(sum(g.issued_lot_mismatches), 0)::int AS issued_lot_mismatches
         FROM subscription_term s
         CROSS JOIN LATERAL (
           SELECT sum(gs.value_fen) AS value_fen,
                  sum(CASE WHEN gs.status = 'granted' THEN l.cost_basis_fen
                           ELSE gs.value_fen END) AS settled_value_fen,
                  count(*) FILTER (WHERE gs.status = 'granted'
                                     AND l.cost_basis_fen IS DISTINCT FROM gs.value_fen)::int
                    AS issued_lot_mismatches
             FROM grant_schedule gs LEFT JOIN point_lot l ON l.id = gs.point_lot_id
            WHERE gs.subscription_term_id = s.id) g
         CROSS JOIN LATERAL (
           SELECT COALESCE((SELECT sum(up.paid_amount_fen) FROM billing_order up
                            WHERE up.entity_id=s.entity_id AND up.type='plan_upgrade'
                              AND up.fulfillment_status='done'
                              AND EXISTS (SELECT 1 FROM subscription_event e
                                           WHERE e.subscription_term_id=s.id AND e.type='upgraded'
                                             AND e.billing_order_id=up.id)),0)::bigint AS paid_fen,
                  COALESCE((SELECT sum(l.cost_basis_fen) FROM point_lot l
                            WHERE l.entity_id=s.entity_id AND l.subscription_term_id=s.id
                              AND l.source_type='grant_upgrade'),0)::bigint AS lot_fen) u
        WHERE s.source_billing_order_id = o.id) t
    WHERE o.fulfillment_status = 'done' AND o.type IN ('plan_new', 'plan_renew')
      AND (t.terms <> 1 OR t.value_fen <> o.paid_amount_fen + t.upgrade_fen
                       OR t.settled_value_fen <> o.paid_amount_fen + t.upgrade_fen
                       OR t.issued_lot_mismatches > 0)
    UNION ALL
   SELECT 'billing_order', o.id, o.entity_id,
          jsonb_build_object('problem','upgrade_event_count','events',e.events)
     FROM billing_order o
     CROSS JOIN LATERAL (
       SELECT count(*)::int AS events FROM subscription_event e
       JOIN subscription_term t ON t.id=e.subscription_term_id AND t.entity_id=o.entity_id
       WHERE e.billing_order_id=o.id AND e.entity_id=o.entity_id AND e.type='upgraded') e
    WHERE o.fulfillment_status='done' AND o.type='plan_upgrade' AND e.events<>1
    UNION ALL
   SELECT 'billing_order', o.id, o.entity_id,
          jsonb_build_object('problem', CASE WHEN l.lots <> 1 THEN 'lot_count' ELSE 'lot_cost' END,
                             'lots', l.lots, 'paidAmountFen', o.paid_amount_fen, 'costBasisFen', l.cost_fen)
     FROM billing_order o
     CROSS JOIN LATERAL (
       SELECT count(*)::int AS lots, COALESCE(sum(p.cost_basis_fen), 0)::bigint AS cost_fen
         FROM point_lot p WHERE p.source_type = 'purchase' AND p.source_id = o.id) l
    WHERE o.fulfillment_status = 'done' AND o.type = 'topup'
      AND (l.lots <> 1 OR l.cost_fen <> o.paid_amount_fen)`,
);

const valuationFields = [
  "pointLedgerEntryId",
  "valuationPolicyVersionNo",
  "pointLedgerEntrySeq",
  "pointLotId",
  "entityId",
  "bizDate",
  "effect",
  "valueFen",
  "remainingValueFen",
] as const;
const dailyFields = [
  "bizDate",
  "entityId",
  "subStatus",
  "planId",
  "planRevisionId",
  "subscriptionTermId",
  "termMonths",
  "mrrFen",
  "planAvailablePoints",
  "addonAvailablePoints",
  "heldPoints",
  "liabilityPoints",
  "liabilityValueFen",
  "deferredPlanFeeFen",
] as const;
function equalFields<T>(a: T, b: T, keys: readonly (keyof T)[]) {
  const equal = (left: unknown, right: unknown) =>
    left instanceof Date && right instanceof Date
      ? left.getTime() === right.getTime()
      : left === right;
  return keys.every((key) => equal(a[key], b[key]));
}
const LIMIT = 500;
function reportingInvariant(
  code: "billing.I11" | "billing.I13",
  checkEntity: (tx: Tx, entityId: string, at: Date) => Promise<InvariantViolation[]>,
): InvariantRegistration {
  return {
    code,
    severity: "P1",
    modes: ["full"],
    heal: "none",
    run: async (tx, scope, ctx) => {
      const at = invariantNow(ctx),
        found: InvariantViolation[] = [];
      let cursor: string | undefined;
      for (;;) {
        const accounts = await tx.billingAccount.findMany({
          where: {
            ...(scope.entityIds?.length
              ? { entityId: { in: [...scope.entityIds], ...(cursor ? { gt: cursor } : {}) } }
              : cursor
                ? { entityId: { gt: cursor } }
                : {}),
          },
          select: { entityId: true },
          orderBy: { entityId: "asc" },
          take: 200,
        });
        for (const { entityId } of accounts) {
          try {
            found.push(...(await checkEntity(tx, entityId, at)));
          } catch (error) {
            if (isNotBlockage(error)) throw error;
            found.push({
              entityId,
              subject:
                code === "billing.I13"
                  ? {
                      type: "billing_entity_daily",
                      key: `${addDays(calendarDate(at), -1)}:${entityId}`,
                    }
                  : { type: "billing_account", id: entityId },
              detail: {
                problem:
                  error instanceof BillingDailyHistoryMissingError
                    ? "history_snapshot_missing"
                    : "source_replay_failed",
              },
            });
          }
          if (found.length >= LIMIT) return found.slice(0, LIMIT);
          cursor = entityId;
        }
        if (accounts.length < 200) return found;
      }
    },
  };
}

/** 与每日产出同一已闭业务日边界；今日新流水不要求提前生成估值，历史缺行仍报告。 */
const i11 = reportingInvariant("billing.I11", async (tx, entityId, at) => {
  const through = toDateColumn(addDays(calendarDate(at), -1));
  const expected = (await computeEntityValuation(tx, entityId, at)).filter(
    (row) => row.bizDate <= through,
  );
  const stored = await tx.pointEntryValuation.findMany({
    where: { entityId, valuationPolicyVersionNo: 1, bizDate: { lte: through } },
  });
  const wanted = new Map(expected.map((row) => [row.pointLedgerEntryId, row])),
    actual = new Map(stored.map((row) => [row.pointLedgerEntryId, row]));
  const found: InvariantViolation[] = [];
  for (const id of new Set([...wanted.keys(), ...actual.keys()])) {
    const a = wanted.get(id),
      b = actual.get(id);
    if (!a || !b || !equalFields(a, b, valuationFields))
      found.push({
        entityId,
        subject: { type: "point_lot", id: (a ?? b)!.pointLotId },
        detail: {
          problem: !a ? "valuation_unexpected" : !b ? "valuation_missing" : "valuation_mismatch",
          pointLedgerEntryId: id,
        },
      });
  }
  return found;
});

/** 日快照业务字段与正式只读回放逐日相等；不能用已有投影作为期望，亦不能自愈。 */
const i13 = reportingInvariant("billing.I13", async (tx, entityId, at) => {
  const through = addDays(calendarDate(at), -1),
    { days } = await computeEntityDaily(tx, entityId, through, at),
    stored = await tx.billingEntityDaily.findMany({
      where: { entityId, bizDate: { lte: toDateColumn(through) } },
    }),
    wanted = new Map(days.map((row) => [fromDateColumn(row.bizDate), row])),
    actual = new Map(stored.map((row) => [fromDateColumn(row.bizDate), row]));
  const found: InvariantViolation[] = [];
  for (const date of new Set([...wanted.keys(), ...actual.keys()])) {
    const a = wanted.get(date),
      b = actual.get(date);
    if (!a || !b || !equalFields(a, b, dailyFields))
      found.push({
        entityId,
        subject: { type: "billing_entity_daily", key: `${date}:${entityId}` },
        detail: { problem: !a ? "daily_unexpected" : !b ? "daily_missing" : "daily_mismatch" },
      });
  }
  const entries = await tx.pointLedgerEntry.findMany({
    where: { entityId, bizDate: { lte: toDateColumn(through) } },
    orderBy: [{ bizDate: "asc" }, { seq: "asc" }],
  });
  const balances = new Map<string, number>(),
    flows = new Map<string, { opening: number; closing: number; delta: number }>();
  for (const entry of entries) {
    const group = entry.lotKind === "addon" ? "addon" : entry.planId,
      key = `${fromDateColumn(entry.bizDate)}:${group}`,
      before = balances.get(group ?? "") ?? 0,
      liabilities = (bucket: string) => bucket === "available" || bucket === "held",
      after =
        before +
        (Number(liabilities(entry.toBucket)) - Number(liabilities(entry.fromBucket))) * entry.qty;
    const pair = `${entry.fromBucket}:${entry.toBucket}`;
    const change = ["external:available", "consumed:available", "expired:available"].includes(pair)
      ? entry.qty
      : [
            "held:consumed",
            "available:expired",
            "held:expired",
            "held:converted_out",
            "available:adjusted_out",
            "available:revoked",
          ].includes(pair)
        ? -entry.qty
        : [
              "available:held",
              "held:available",
              "consumed:converted_out",
              "consumed:expired",
              "expired:revoked",
            ].includes(pair)
          ? 0
          : undefined;
    if (change === undefined || group === null || after < 0)
      found.push({
        entityId,
        subject: { key },
        detail: {
          problem: "report_flow_invalid",
          bizDate: fromDateColumn(entry.bizDate),
          source: group,
        },
      });
    const flow = flows.get(key) ?? { opening: before, closing: before, delta: 0 };
    flow.closing = after;
    flow.delta += change ?? 0;
    flows.set(key, flow);
    balances.set(group ?? "", after);
  }
  for (const [key, flow] of flows)
    if (flow.opening + flow.delta !== flow.closing)
      found.push({
        entityId,
        subject: { key },
        detail: { problem: "report_identity", ...flow },
      });
  return found;
});

/** 订阅及报表检查，按编号 */
const i15 = check(
  "billing.I15",
  "P2",
  `SELECT 'plan_revision' AS subject_type, id AS subject_id, NULL::uuid AS entity_id,
          jsonb_build_object('problem','multiple_pending_plan_revisions') AS detail
     FROM (SELECT id, row_number() OVER (PARTITION BY plan_id ORDER BY effective_at,id) AS n
             FROM plan_revision WHERE effective_at > $2::timestamptz AND cancelled_at IS NULL) p
    WHERE n > 1
    UNION ALL
   SELECT 'billing_param', id, NULL::uuid,
          jsonb_build_object('problem','multiple_pending_parameter_revisions')
     FROM (SELECT id, row_number() OVER (PARTITION BY key ORDER BY effective_at,id) AS n
             FROM billing_param WHERE effective_at > $2::timestamptz AND cancelled_at IS NULL) p
    WHERE n > 1`,
);

export const subscriptionInvariants: readonly InvariantRegistration[] = [
  i9,
  i10,
  i11,
  i12,
  i13,
  i15,
];
