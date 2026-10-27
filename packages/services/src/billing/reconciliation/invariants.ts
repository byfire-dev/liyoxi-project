import { invariantNow } from "../../kernel/index.js";
import type { InvariantRegistration } from "../../kernel/index.js";

function check(code: string, sql: string): InvariantRegistration {
  return {
    code,
    severity: "P1",
    modes: ["full"],
    heal: "none",
    async run(tx, scope, ctx) {
      const rows = await tx.$queryRawUnsafe<
        { id: string; entity_id: string | null; kind: string; detail: Record<string, unknown> }[]
      >(
        `
      SELECT id::text, entity_id::text, kind, detail FROM (${sql}) bad
      WHERE ($1::uuid[] IS NULL OR entity_id=ANY($1::uuid[])) AND $2::timestamptz IS NOT NULL
      ORDER BY id LIMIT 500`,
        scope.entityIds?.length ? [...scope.entityIds] : null,
        invariantNow(ctx),
      );
      return rows.map((r) => ({
        subject: { type: r.kind, id: r.id },
        ...(r.entity_id ? { entityId: r.entity_id } : {}),
        detail: r.detail,
      }));
    },
  };
}
/** 从持久行/现金/原件证据反查，不调用matcher来计算预期。 */
export const reconciliationInvariants: readonly InvariantRegistration[] = [
  check(
    "payment.I7",
    `
    SELECT l.id, p.entity_id, 'wx_bill_line' kind, jsonb_build_object('problem','uncovered_or_false_match') detail
    FROM wx_bill_line l JOIN wx_bill_file f ON f.id=l.wx_bill_file_id
    LEFT JOIN payment_txn p ON p.id=l.matched_payment_txn_id
    LEFT JOIN refund_txn r ON r.id=l.matched_refund_txn_id
    WHERE f.status='parsed' AND NOT l.is_foreign AND (
      (l.match_state NOT IN ('matched','matched_pending') AND NOT EXISTS(SELECT 1 FROM payment_exception e WHERE e.wx_bill_line_id=l.id))
      OR (l.match_state='matched' AND l.line_kind='payment' AND
        (p.id IS NULL OR p.status <> 'succeeded' OR p.out_trade_no <> l.out_trade_no OR p.channel_txn_no IS DISTINCT FROM l.transaction_id
         OR p.channel_amount_fen IS DISTINCT FROM l.order_amount_fen))
      OR (l.match_state IN ('matched','matched_pending') AND l.line_kind='refund' AND
        (r.id IS NULL OR r.out_refund_no IS DISTINCT FROM l.out_refund_no OR p.id IS NULL OR p.out_trade_no <> l.out_trade_no
         OR f.summary->'refundApplications'->>'v' IS DISTINCT FROM '1'
         OR f.summary->'refundApplications'->>'sha1' IS DISTINCT FROM f.sha1
         OR r.amount_fen::numeric IS DISTINCT FROM CASE
           WHEN jsonb_typeof(f.summary->'refundApplications'->'amounts'->l.line_no::text)='number'
           THEN (f.summary->'refundApplications'->'amounts'->>l.line_no::text)::numeric END
         OR (l.match_state='matched' AND (r.status <> 'succeeded' OR l.refund_state <> 'SUCCESS' OR r.channel_refund_no IS DISTINCT FROM l.refund_id))))
    )
    UNION ALL
    SELECT f.id, NULL::uuid, 'wx_bill_file', jsonb_build_object('problem','parsed_original_or_line_count')
    FROM wx_bill_file f WHERE f.status='parsed' AND (
      NOT f.is_hash_verified OR f.file_id IS NULL OR f.sha1 IS NULL OR f.downloaded_at IS NULL
      OR f.line_count IS DISTINCT FROM (SELECT count(*)::int FROM wx_bill_line l WHERE l.wx_bill_file_id=f.id)
      OR f.summary->>'totalCount' IS DISTINCT FROM f.line_count::text
      OR EXISTS(SELECT 1 FROM wx_bill_line l WHERE l.wx_bill_file_id=f.id AND (l.bill_date <> f.bill_date OR l.line_no > f.line_count)))`,
  ),
  check(
    "payment.I8",
    `
    SELECT d.id, NULL::uuid entity_id, 'recon_day' kind, jsonb_build_object('problem','ok_without_equal_complete_facts') detail
    FROM recon_day d WHERE d.channel='wechat_jsapi' AND d.status='ok' AND (
      NOT EXISTS(SELECT 1 FROM wx_bill_file f WHERE f.bill_date=d.bill_date AND f.status='parsed' AND f.is_hash_verified)
      OR d.platform_pay_count <> d.bill_pay_count OR d.platform_pay_fen <> d.bill_pay_fen
      OR EXISTS(SELECT 1 FROM payment_exception e WHERE e.bill_date=d.bill_date AND e.status IN ('open','resolving'))
      OR d.platform_pay_count <> (SELECT count(*) FROM payment_txn p WHERE p.channel='wechat_jsapi' AND p.status='succeeded'
        AND (p.channel_success_at AT TIME ZONE 'Asia/Shanghai')::date=d.bill_date)
      OR d.platform_pay_fen <> (SELECT COALESCE(sum(p.channel_amount_fen::bigint),0) FROM payment_txn p WHERE p.channel='wechat_jsapi' AND p.status='succeeded'
        AND (p.channel_success_at AT TIME ZONE 'Asia/Shanghai')::date=d.bill_date)
      OR d.bill_pay_count <> (SELECT count(*) FROM wx_bill_line l JOIN wx_bill_file f ON f.id=l.wx_bill_file_id WHERE f.status='parsed' AND l.bill_date=d.bill_date AND NOT l.is_foreign AND l.line_kind='payment')
      OR d.bill_pay_fen <> (SELECT COALESCE(sum(l.order_amount_fen::bigint),0) FROM wx_bill_line l JOIN wx_bill_file f ON f.id=l.wx_bill_file_id WHERE f.status='parsed' AND l.bill_date=d.bill_date AND NOT l.is_foreign AND l.line_kind='payment'))`,
  ),
];
