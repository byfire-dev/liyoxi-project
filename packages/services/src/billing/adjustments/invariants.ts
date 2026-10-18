// 07分组2.20/2.21：两种即时执行审批与计费结果必须同TX一致，不检查后续可变的周期止日。
import { check } from "../invariants.js";

export const adjustmentInvariants = [
  check(
    "billing.I18",
    "P1",
    `
  SELECT 'point_adjustment_request' AS subject_type, r.id AS subject_id, r.entity_id,
    jsonb_build_object('problem','adjustment_execution','approvalId',a.id,'approvalStatus',a.status,
      'ledgerOperationId',r.ledger_operation_id,'appliedAt',r.applied_at) AS detail
  FROM point_adjustment_request r JOIN approval_request a ON a.id=r.approval_request_id
    LEFT JOIN ledger_operation o ON o.id=r.ledger_operation_id
  WHERE a.kind<>'points_adjust' OR a.entity_id IS DISTINCT FROM r.entity_id
    OR (a.status='approved') IS DISTINCT FROM (r.applied_at IS NOT NULL)
    OR (r.applied_at IS NOT NULL AND (
      o.id IS NULL OR o.entity_id IS DISTINCT FROM r.entity_id
      OR o.ref_type IS DISTINCT FROM 'approval_request' OR o.ref_id IS DISTINCT FROM a.id
      OR o.op_type IS DISTINCT FROM CASE WHEN r.reason_code='platform_refund' THEN 'refund' ELSE 'adjust' END
      OR o.occurred_at IS DISTINCT FROM r.applied_at))
  UNION ALL
  SELECT 'term_extension_request', r.id, r.entity_id,
    jsonb_build_object('problem','extension_execution','approvalId',a.id,'approvalStatus',a.status,
      'ledgerOperationId',r.ledger_operation_id,'appliedAt',r.applied_at,
      'appliedMode',r.applied_mode,'prevEndDate',r.prev_end_date,'newEndDate',r.new_end_date)
  FROM term_extension_request r JOIN approval_request a ON a.id=r.approval_request_id
    LEFT JOIN ledger_operation o ON o.id=r.ledger_operation_id
    LEFT JOIN subscription_term t ON t.id=r.applied_subscription_term_id
  WHERE a.kind<>'subscription_extend' OR a.entity_id IS DISTINCT FROM r.entity_id
    OR (a.status='approved') IS DISTINCT FROM (r.applied_at IS NOT NULL)
    OR (r.applied_at IS NOT NULL AND (
      o.id IS NULL OR o.entity_id IS DISTINCT FROM r.entity_id
      OR o.ref_type IS DISTINCT FROM 'approval_request' OR o.ref_id IS DISTINCT FROM a.id
      OR o.op_type IS DISTINCT FROM 'extend' OR o.occurred_at IS DISTINCT FROM r.applied_at
      OR t.id IS NULL OR t.entity_id IS DISTINCT FROM r.entity_id
      OR r.new_end_date IS DISTINCT FROM CASE WHEN r.applied_mode='extend' THEN r.prev_end_date+r.days
        WHEN r.applied_mode='revive' THEN greatest(r.prev_end_date,(r.applied_at AT TIME ZONE 'Asia/Shanghai')::date-1)+r.days END))
`,
  ),
];
