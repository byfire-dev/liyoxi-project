import type { Tx } from "../kernel/index.js";

/** 草稿删除判断完整提交历史，不按审核结果、轮次类型或关闭状态裁剪。 */
export function countSubmittedQualificationHistory(
  tx: Tx,
  input: { entityId: string; storeId: string },
) {
  return tx.qualificationSubmission.count({ where: { ...input, submittedAt: { not: null } } });
}

/** m03 第1.2节：initial、new_store、change 的已提交未关闭轮次均阻止停用。 */
export function countQualificationSubmissionsInReview(tx: Tx, storeId: string): Promise<number> {
  return tx.qualificationSubmission.count({
    where: { storeId, submittedAt: { not: null }, closedAt: null },
  });
}

/** 主体尚未认证时保留首家门店；其余门店不计入本项。 */
export function countUnverifiedPrimaryStore(tx: Tx, storeId: string): Promise<number> {
  return tx.store.count({
    where: { id: storeId, isPrimary: true, entity: { verificationStatus: { not: "verified" } } },
  });
}
