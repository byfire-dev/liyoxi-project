import { IdSchema } from "@liyoxi/contract";
import type { Clock, TxRunner } from "../../kernel/index.js";
/** 私有live入口只提交它刚成功登记的本人同主体单个凭证，不运行全库任务。 */
export async function findBillingLiveUploadJobIds(
  { tx, clock }: { tx: Pick<TxRunner, "run">; clock: Clock },
  { staffId, entityId, fileIds }: { staffId: string; entityId: string; fileIds: readonly string[] },
): Promise<string[]> {
  if (
    !IdSchema.safeParse(staffId).success ||
    !IdSchema.safeParse(entityId).success ||
    fileIds.length > 1 ||
    fileIds.some((id) => !IdSchema.safeParse(id).success)
  )
    throw new Error("凭证上传执行范围不合法");
  if (!fileIds.length) return [];
  return tx.run(async (db) => {
    const files = await db.fileObject.findMany({
      where: {
        id: { in: [...fileIds] },
        category: "pay_receipt",
        bucket: "secure",
        scopeType: "entity",
        entityId,
        uploadActorType: "staff",
        uploadActorId: staffId,
        uploadClient: "admin",
        ext: { in: ["jpg", "jpeg", "png", "pdf"] },
        status: "promoting",
      },
      select: { id: true },
      take: 1,
    });
    if (!files.length) return [];
    const jobs = await db.mediaJob.findMany({
      where: {
        kind: "promote",
        provider: "local",
        mode: "local",
        subjectType: "file_object",
        subjectId: files[0]!.id,
        dedupeKey: `promote:${files[0]!.id}`,
        state: "queued",
        nextRunAt: { lte: clock.now() },
      },
      select: { id: true },
      take: 1,
    });
    return jobs.map((j) => j.id);
  });
}
