// 08 §2.2/2.4/2.5、2.10：真实现金事实不设上限、不自愈；异常超退必须在报告中可见。
import { invariantNow } from "../../kernel/index.js";
import type { InvariantRegistration } from "../../kernel/index.js";
function check(code: string, sql: string): InvariantRegistration {
  return {
    code,
    severity: "P1",
    modes: ["full"],
    heal: "none",
    run: async (tx, scope, ctx) => {
      const found = await tx.$queryRawUnsafe<
        {
          subject_type: string;
          subject_id: string;
          entity_id: string | null;
          detail: Record<string, unknown>;
        }[]
      >(
        `SELECT subject_type, subject_id::text, entity_id::text, detail FROM (${sql}) q WHERE ($1::uuid[] IS NULL OR entity_id=ANY($1::uuid[])) AND $2::timestamptz IS NOT NULL ORDER BY subject_id LIMIT 500`,
        scope.entityIds?.length ? [...scope.entityIds] : null,
        invariantNow(ctx),
      );
      return found.map((r) => ({
        subject: { type: r.subject_type, id: r.subject_id },
        ...(r.entity_id ? { entityId: r.entity_id } : {}),
        detail: r.detail,
      }));
    },
  };
}
export const refundInvariants: readonly InvariantRegistration[] = [
  check(
    "payment.I3",
    `SELECT 'payment_txn' subject_type,t.id subject_id,t.entity_id,jsonb_build_object('recorded',t.refunded_fen,'successful',a.total,'missingOver',t.refunded_fen>t.channel_amount_fen) detail FROM payment_txn t CROSS JOIN LATERAL (SELECT COALESCE(sum(r.amount_fen),0) total FROM refund_txn r WHERE r.payment_txn_id=t.id AND r.status='succeeded') a WHERE t.refunded_fen<>a.total OR (t.refunded_fen>t.channel_amount_fen AND NOT EXISTS(SELECT 1 FROM payment_exception e WHERE e.payment_txn_id=t.id AND e.kind='refund_over'))`,
  ),
  check(
    "payment.I5",
    `SELECT 'refund_request' subject_type,r.id subject_id,r.entity_id,jsonb_build_object('status',r.status,'successful',a.total,'open',a.open_count,'amount',r.amount_fen) detail FROM refund_request r CROSS JOIN LATERAL (SELECT COALESCE(sum(t.amount_fen) FILTER(WHERE t.status='succeeded'),0) total,count(*) FILTER(WHERE t.status IN('created','processing','abnormal')) open_count FROM refund_txn t WHERE t.refund_request_id=r.id) a WHERE (r.status='done') IS DISTINCT FROM (a.total=r.amount_fen) OR (r.status='executing' AND a.open_count<>1) OR (r.status<>'executing' AND a.open_count<>0)`,
  ),
  check(
    "payment.I6",
    `SELECT 'invoice_request' subject_type,i.id subject_id,i.entity_id,jsonb_build_object('status',i.status,'orderStatus',o.status,'blueCount',b.n) detail FROM invoice_request i JOIN billing_order o ON o.id=i.billing_order_id CROSS JOIN LATERAL(SELECT count(*) n,COALESCE(bool_and(d.amount_fen=o.paid_amount_fen),false) valid FROM invoice_doc d WHERE d.invoice_request_id=i.id AND d.doc_kind='blue') b WHERE (o.status='refunded' AND i.status='issued') OR (i.status='issued' AND (b.n<>1 OR NOT b.valid))`,
  ),
  check(
    "payment.I10",
    `SELECT 'refund_request' subject_type,r.id subject_id,r.entity_id,jsonb_build_object('termId',t.id,'termStatus',t.status) detail FROM refund_request r LEFT JOIN subscription_term t ON t.id::text=r.breakdown_snapshot->>'termId' WHERE r.status='done' AND r.rule_code IN('window','qualification_failed','override') AND r.breakdown_snapshot ? 'termId' AND (t.id IS NULL OR t.status NOT IN('refunded','cancelled') OR EXISTS(SELECT 1 FROM point_lot l WHERE l.subscription_term_id=t.id AND l.available_qty<>0)) AND NOT EXISTS(SELECT 1 FROM payment_exception e WHERE e.refund_request_id=r.id AND e.kind='entitlement_unrecovered' AND e.status IN('open','resolving'))`,
  ),
  check(
    "payment.I11",
    `SELECT 'refund_request' subject_type,r.id subject_id,r.entity_id,jsonb_build_object('status',r.status,'approvalStatus',a.status,'kind',a.kind,'closeReason',r.close_reason) detail FROM refund_request r LEFT JOIN approval_request a ON a.id=r.approval_request_id WHERE a.id IS NULL OR a.kind<>'plan_refund' OR NOT ((a.status='pending' AND r.status='pending_approval') OR (a.status IN('rejected','withdrawn') AND r.status='not_executed' AND r.close_reason=a.status) OR (a.status='approved' AND (r.status IN('pending_execution','executing','done') OR (r.status='not_executed' AND r.close_reason='voided'))))`,
  ),
];
