// 08 2.1、2.2、2.6：资金类每日检查，不自愈；时间由调用方注入，孤儿交易不带主体。
import { invariantNow } from "../../kernel/index.js";
import type { InvariantRegistration } from "../../kernel/index.js";

function check(code: string, sql: string): InvariantRegistration {
  return {
    code,
    severity: "P1",
    modes: ["full"],
    heal: "none",
    run: async (tx, scope, ctx) => {
      const rows = await tx.$queryRawUnsafe<
        {
          subject_type: string;
          subject_id: string;
          entity_id: string | null;
          detail: Record<string, unknown>;
        }[]
      >(
        `SELECT subject_type, subject_id::text, entity_id::text, detail FROM (${sql}) found
        WHERE ($1::uuid[] IS NULL OR entity_id = ANY($1::uuid[])) AND $2::timestamptz IS NOT NULL
        ORDER BY subject_id LIMIT 500`,
        scope.entityIds?.length ? [...scope.entityIds] : null,
        invariantNow(ctx),
      );
      return rows.map((row) => ({
        subject: { type: row.subject_type, id: row.subject_id },
        ...(row.entity_id === null ? {} : { entityId: row.entity_id }),
        detail: row.detail,
      }));
    },
  };
}
const i1 = check(
  "payment.I1",
  `
 SELECT 'billing_order' AS subject_type, o.id AS subject_id, o.entity_id,
        jsonb_build_object('appliedCount', a.n, 'invalidReceipt', a.invalid) AS detail
 FROM billing_order o CROSS JOIN LATERAL (
   SELECT count(*)::int n, COALESCE(bool_or(t.status <> 'succeeded'
     OR t.id IS DISTINCT FROM o.paid_payment_txn_id OR t.entity_id IS DISTINCT FROM o.entity_id
     OR t.channel_amount_fen IS DISTINCT FROM o.paid_amount_fen
     OR t.channel_amount_fen IS DISTINCT FROM o.amount_fen), false) invalid
   FROM payment_txn t WHERE t.billing_order_id = o.id AND t.applied_at IS NOT NULL
 ) a WHERE (o.status IN ('paid', 'refunded') AND
     (a.n <> 1 OR a.invalid OR o.fulfillment_status NOT IN ('done', 'blocked')))
     OR (o.status NOT IN ('paid', 'refunded') AND a.n <> 0)`,
);
const i2 = check(
  "payment.I2",
  `
 SELECT 'billing_order' AS subject_type, o.id AS subject_id, o.entity_id,
        jsonb_build_object('problem', 'pending_receipt') AS detail
 FROM billing_order o WHERE o.status IN ('pending_payment', 'pending_confirmation', 'cancelled')
   AND (o.fulfillment_status <> 'none' OR EXISTS (SELECT 1 FROM payment_txn t
     WHERE t.billing_order_id = o.id AND (t.applied_at IS NOT NULL OR
       (o.status IN ('pending_payment', 'pending_confirmation') AND t.status = 'succeeded'))))
 UNION ALL
 SELECT 'payment_txn', t.id, t.entity_id, jsonb_build_object('problem', 'unapplied_without_exception')
 FROM payment_txn t WHERE t.status = 'succeeded' AND t.applied_at IS NULL
   AND t.refunded_fen < t.channel_amount_fen AND t.channel_success_at < $2::timestamptz - interval '10 minutes'
   AND NOT EXISTS (SELECT 1 FROM payment_exception e WHERE e.payment_txn_id = t.id AND e.status IN ('open', 'resolving'))`,
);
const i4 = check(
  "payment.I4",
  `
 SELECT 'billing_order' AS subject_type, o.id AS subject_id, o.entity_id,
        jsonb_build_object('problem', CASE WHEN o.paid_at < $2::timestamptz - interval '72 hours'
          THEN 'blocked_overdue' ELSE 'missing_exception' END) AS detail
 FROM billing_order o WHERE o.fulfillment_status = 'blocked' AND o.status <> 'refunded'
   AND (o.paid_at < $2::timestamptz - interval '72 hours' OR NOT EXISTS (
     SELECT 1 FROM payment_exception e WHERE e.billing_order_id = o.id AND e.kind = 'fulfillment_blocked'
       AND e.status IN ('open', 'resolving')))`,
);
export const paymentInvariants: readonly InvariantRegistration[] = [i1, i2, i4];
