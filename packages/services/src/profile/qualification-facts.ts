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
