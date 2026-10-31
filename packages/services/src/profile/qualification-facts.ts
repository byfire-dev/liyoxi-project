import type { Tx } from "../kernel/index.js";
import { AppError } from "../kernel/index.js";

/** d9§7.1：主体结论与最近一轮已提交 initial 的终局事实，两者必须同时成立。 */
export async function isQualificationDead(tx: Tx, entityId: string): Promise<boolean> {
  const entity = await tx.entity.findUnique({
    where: { id: entityId },
    select: { verificationStatus: true },
  });
  if (entity?.verificationStatus !== "rejected") return false;
  const latest = await tx.qualificationSubmission.findFirst({
    where: { entityId, kind: "initial", submittedAt: { not: null } },
    orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
    select: { finalRejectedAt: true },
  });
  return latest?.finalRejectedAt != null;
}

/** M5订单后续只读当前已提交的逐店资质轮次；调用方在父行锁后重读以拒绝陈旧事件。 */
export async function readOrderQualificationRound(
  tx: Tx,
  input: { readonly entityId: string; readonly storeId: string },
) {
  const row = await tx.qualificationSubmission.findFirst({
    where: { ...input, kind: { in: ["initial", "new_store"] }, submittedAt: { not: null } },
    orderBy: [{ roundNo: "desc" }, { id: "desc" }],
    select: {
      id: true,
      roundNo: true,
      kind: true,
      outcome: true,
      submittedAt: true,
      closedAt: true,
      finalRejectedAt: true,
      approvalRequestId: true,
      approvalRequest: { select: { status: true, decidedByStaffId: true } },
    },
  });
  if (!row) return null;
  if (
    row.roundNo === null ||
    row.submittedAt === null ||
    !row.approvalRequestId ||
    !row.approvalRequest
  )
    throw new AppError("PRECONDITION_CHANGED", { message: "已提交资质轮次缺少审批事实" });
  return {
    submissionId: row.id,
    roundNo: row.roundNo,
    kind: row.kind,
    outcome: row.outcome,
    submittedAt: row.submittedAt,
    closedAt: row.closedAt,
    finalRejectedAt: row.finalRejectedAt,
    approvalRequestId: row.approvalRequestId,
    approvalStatus: row.approvalRequest.status,
    decidedByStaffId: row.approvalRequest.decidedByStaffId,
  };
}

/** 对账候选只按当前已提交轮次判断；包含没有订单、只有待指派广告的门店。 */
export async function listFinalRejectedQualificationScopes(
  tx: Tx,
  input: { readonly cursor?: string; readonly limit: number },
): Promise<{ entityId: string; storeId: string }[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1)
    throw new TypeError("终局资质候选页容量必须是正整数");
  const cursor = input.cursor ?? null;
  // 先选最近已提交轮次，再筛终局；先筛旧终局行会把后续重提/通过误当作仍需取消。
  return tx.$queryRaw<{ entityId: string; storeId: string }[]>`
    SELECT s.entity_id::text AS "entityId", s.id::text AS "storeId"
      FROM store s
      JOIN entity e ON e.id = s.entity_id
      JOIN LATERAL (
        SELECT q.outcome, q.final_rejected_at, q.approval_request_id
          FROM qualification_submission q
         WHERE q.entity_id = s.entity_id AND q.store_id = s.id
           AND q.kind IN ('initial', 'new_store') AND q.submitted_at IS NOT NULL
         ORDER BY q.round_no DESC, q.id DESC
         LIMIT 1
      ) current_round ON true
      JOIN approval_request approval ON approval.id = current_round.approval_request_id
     WHERE s.lifecycle = 'active' AND e.lifecycle = 'active'
       AND s.qualification_status = 'rejected'
       AND current_round.outcome = 'rejected'
       AND current_round.final_rejected_at IS NOT NULL
       AND approval.status = 'rejected'
       AND (${cursor}::uuid IS NULL OR s.id > ${cursor}::uuid)
     ORDER BY s.id
     LIMIT ${input.limit}::int
  `;
}
