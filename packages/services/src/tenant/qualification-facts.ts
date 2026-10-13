import type { Tx } from "../kernel/index.js";

/** 02:625：终局事实来自已关闭的真实轮次，不能只信调用参数或profile缓存。 */
export async function hasFinalQualificationRejection(tx: Tx, storeId: string) {
  return (
    (await tx.qualificationSubmission.count({
      where: {
        storeId,
        kind: { in: ["initial", "new_store"] },
        outcome: "rejected",
        closedAt: { not: null },
        finalRejectedAt: { not: null },
      },
    })) > 0
  );
}
