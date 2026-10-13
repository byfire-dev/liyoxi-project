import type { InvariantScope, Tx } from "../kernel/index.js";

/** 单批最多32轮；第33行仅判断是否需下一批。赢家唯一性不按生命周期或scope过滤。 */
export async function qualificationDuplicateBatch(
  tx: Tx,
  scope: InvariantScope,
  bidx?: Uint8Array,
) {
  const candidates = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT d.id::text AS id FROM qualification_doc d
      JOIN qualification_submission q ON q.id=d.qualification_submission_id
      JOIN entity loser ON loser.id=q.entity_id
      JOIN store s ON s.id=q.store_id
      JOIN entity winner ON winner.uscc_bidx=d.cert_no_bidx
        AND winner.verification_status='verified' AND winner.id<>q.entity_id
      WHERE d.doc_type='business_license' AND d.removed_at IS NULL
        AND q.submitted_at IS NOT NULL AND q.closed_at IS NULL
        AND loser.lifecycle='active' AND s.lifecycle='active'
        AND ($1::bytea IS NULL OR d.cert_no_bidx=$1::bytea)
        AND ($2::uuid[] IS NULL OR q.entity_id=ANY($2::uuid[]))
      ORDER BY d.id LIMIT 33`,
    bidx ? Buffer.from(bidx) : null,
    scope.entityIds ? [...scope.entityIds] : null,
  );
  return { ids: candidates.slice(0, 32).map((row) => row.id), more: candidates.length > 32 };
}
