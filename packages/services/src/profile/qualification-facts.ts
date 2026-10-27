import type { Tx } from "../kernel/index.js";

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
