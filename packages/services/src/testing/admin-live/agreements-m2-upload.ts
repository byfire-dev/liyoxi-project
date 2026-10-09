import { IdSchema } from "@liyoxi/contract";
import type { Clock, TxRunner } from "../../kernel/index.js";

/** Test-server scheduling only: every ID must come from its own successful registration. */
export async function findAgreementLiveUploadJobIds(
  { tx, clock }: { tx: Pick<TxRunner, "run">; clock: Clock },
  { staffId, fileIds }: { staffId: string; fileIds: readonly string[] },
): Promise<string[]> {
  if (
    !IdSchema.safeParse(staffId).success ||
    fileIds.length > 8 ||
    new Set(fileIds).size !== fileIds.length ||
    fileIds.some((id) => !IdSchema.safeParse(id).success)
  )
    throw new Error("协议上传执行范围不合法");
  if (fileIds.length === 0) return [];
  const now = clock.now();
  return tx.run(async (db) => {
    const files = await db.fileObject.findMany({
      where: {
        id: { in: [...fileIds] },
        category: "legal_doc",
        scopeType: "platform",
        entityId: null,
        storeId: null,
        uploadActorType: "staff",
        uploadActorId: staffId,
        uploadClient: "admin",
        ext: { in: ["docx", "pdf"] },
        status: "promoting",
      },
      select: { id: true },
      take: 8,
    });
    if (files.length === 0) return [];
    const jobs = await db.mediaJob.findMany({
      where: {
        kind: "promote",
        provider: "local",
        mode: "local",
        subjectType: "file_object",
        subjectId: { in: files.map((file) => file.id) },
        state: "queued",
        nextRunAt: { lte: now },
      },
      select: { id: true, subjectId: true, dedupeKey: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 8,
    });
    return jobs.filter((job) => job.dedupeKey === `promote:${job.subjectId}`).map((job) => job.id);
  });
}
