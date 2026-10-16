// billing 的不变量：订阅一侧的三条——billing.I9、I10、I12（W1-11a）。
// 依据：07 分组 第 2.8、2.9、2.11、5.6 节；D1 第 9 节。写法、调度、不自愈同账户与批次的七条（../invariants.ts）。
// I10 是“周期不重叠”的第二道防线（第一道是建周期时的服务层校验），库里的排他约束在不在都成立。
// I12核套餐与正式升级资金、发放/未发放权益成本；已退款的收回规则由退款域接续。
// 受阻的付款单有没有未决差异单、受阻多久，归付款一侧的 payment.I4。
import type { InvariantRegistration } from "../../kernel/index.js";
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

/** 订阅一侧的三条，按编号 */
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

export const subscriptionInvariants: readonly InvariantRegistration[] = [i9, i10, i12, i15];
