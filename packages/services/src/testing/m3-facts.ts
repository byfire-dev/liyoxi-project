// 本轮隔离库内的只读证据；不修状态、不预填检测/洞察/制作结论。
import type { Prisma } from "@liyoxi/db";
import { isUuid } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

export interface M3MediaScope {
  readonly fileIds?: readonly string[];
  readonly assetIds?: readonly string[];
  readonly batchIds?: readonly string[];
  readonly dramaIds?: readonly string[];
  readonly playableAssetIds?: readonly string[];
  readonly ocrResultIds?: readonly string[];
}
const fields = [
  "fileIds",
  "assetIds",
  "batchIds",
  "dramaIds",
  "playableAssetIds",
  "ocrResultIds",
] as const;
const unique = (ids: readonly string[]) => [...new Set(ids)].sort();
const bounded = (rows: readonly unknown[], label: string): void => {
  if (rows.length > 512) throw new Error(`M3 ${label} 超出单轮小样本上界`);
};
function validateScope(input: M3MediaScope) {
  if (!input || Object.keys(input).some((key) => !fields.some((field) => field === key)))
    throw new TypeError("M3 事实范围字段不合法");
  for (const field of fields) {
    const ids = input[field] ?? [];
    if (!Array.isArray(ids) || ids.length > 64 || !ids.every((id) => isUuid(id)))
      throw new TypeError(`M3 ${field} 必须为至多 64 个真实 UUID`);
  }
  if (!fields.some((field) => input[field]?.length)) throw new TypeError("M3 不接受空范围全库扫描");
  return {
    fileIds: unique(input.fileIds ?? []),
    assetIds: unique(input.assetIds ?? []),
    batchIds: unique(input.batchIds ?? []),
    dramaIds: unique(input.dramaIds ?? []),
    playableAssetIds: unique(input.playableAssetIds ?? []),
    ocrResultIds: unique(input.ocrResultIds ?? []),
  };
}

export async function resolveM3Scope(tx: Tx, input: M3MediaScope) {
  const scope = validateScope(input);
  const [dramas, copyrights, permits, masters, episodes, batches, assets, playables, ocr] =
    await Promise.all([
      tx.drama.findMany({
        where: { id: { in: scope.dramaIds } },
        select: { id: true, posterFileId: true, status: true },
        take: 513,
      }),
      tx.dramaCopyright.findMany({
        where: { dramaId: { in: scope.dramaIds } },
        select: { dramaId: true, proofFileIds: true },
        take: 513,
      }),
      tx.dramaPermit.findMany({
        where: { dramaId: { in: scope.dramaIds } },
        select: { id: true, scanFileIds: true, status: true },
        take: 513,
      }),
      tx.dramaEpisodeMaster.findMany({
        where: { dramaId: { in: scope.dramaIds } },
        select: { id: true, fileId: true, uploadBatchId: true, state: true, isCurrent: true },
        take: 513,
      }),
      tx.dramaEpisode.findMany({
        where: { dramaId: { in: scope.dramaIds } },
        select: { id: true },
        take: 513,
      }),
      tx.uploadBatch.findMany({
        where: {
          OR: [
            { id: { in: scope.batchIds } },
            { purpose: "drama_master", targetId: { in: scope.dramaIds } },
          ],
        },
        select: { id: true, state: true },
        take: 513,
      }),
      tx.storeAsset.findMany({
        where: { id: { in: scope.assetIds } },
        select: {
          id: true,
          type: true,
          processingState: true,
          isInsightPartial: true,
          reviewState: true,
          usability: true,
          moderationState: true,
          adoptedCount: true,
          portraitAuthFileIds: true,
          portraitAuthorizedAt: true,
          deletedAt: true,
          lockVersion: true,
        },
        take: 513,
      }),
      tx.playableAsset.findMany({
        where: {
          OR: [
            { id: { in: scope.playableAssetIds } },
            { ownerType: "drama", ownerId: { in: scope.dramaIds } },
          ],
        },
        orderBy: { id: "asc" },
        take: 513,
      }),
      tx.ocrResult.findMany({
        where: { OR: [{ id: { in: scope.ocrResultIds } }, { fileId: { in: scope.fileIds } }] },
        select: {
          id: true,
          fileId: true,
          status: true,
          docType: true,
          provider: true,
          fieldsEnc: true,
          rawEnc: true,
          rawPurgeAt: true,
          warnings: true,
        },
        orderBy: { id: "asc" },
        take: 513,
      }),
    ]);
  for (const [label, rows] of Object.entries({
    dramas,
    copyrights,
    permits,
    masters,
    episodes,
    batches,
    assets,
    playables,
    ocr,
  }))
    bounded(rows, label);
  const batchIds = unique([...scope.batchIds, ...batches.map((row) => row.id)]);
  const [batchItems, batchFiles, assetFiles] = await Promise.all([
    tx.uploadBatchItem.findMany({
      where: { uploadBatchId: { in: batchIds } },
      select: { id: true, fileId: true, state: true },
      take: 513,
    }),
    tx.fileObject.findMany({
      where: { uploadBatchId: { in: batchIds } },
      select: { id: true },
      take: 513,
    }),
    tx.storeAssetFile.findMany({
      where: { storeAssetId: { in: scope.assetIds } },
      select: { fileId: true },
      take: 513,
    }),
  ]);
  bounded(batchItems, "batch items");
  bounded(batchFiles, "batch files");
  bounded(assetFiles, "asset files");
  const fileIds = unique([
    ...scope.fileIds,
    ...dramas.flatMap((row) => (row.posterFileId ? [row.posterFileId] : [])),
    ...copyrights.flatMap((row) => row.proofFileIds),
    ...permits.flatMap((row) => row.scanFileIds),
    ...masters.map((row) => row.fileId),
    ...batchFiles.map((row) => row.id),
    ...batchItems.flatMap((row) => (row.fileId ? [row.fileId] : [])),
    ...assetFiles.map((row) => row.fileId),
    ...assets.flatMap((row) => row.portraitAuthFileIds),
    ...ocr.map((row) => row.fileId),
    ...playables.flatMap((row) => [
      row.sourceFileId,
      ...(row.coverFileId ? [row.coverFileId] : []),
    ]),
  ]);
  const relatedIds = unique([
    ...scope.dramaIds,
    ...scope.assetIds,
    ...batchIds,
    ...permits.map((row) => row.id),
    ...masters.map((row) => row.id),
    ...playables.map((row) => row.id),
    ...fileIds,
  ]);
  const refs = await tx.fileRef.findMany({
    where: { OR: [{ fileId: { in: fileIds } }, { refId: { in: relatedIds } }] },
    orderBy: { id: "asc" },
    take: 513,
  });
  bounded(refs, "file refs");
  const allFileIds = unique([...fileIds, ...refs.map((row) => row.fileId)]);
  bounded(allFileIds, "resolved files");
  const jobWhere: Prisma.MediaJobWhereInput = {
    OR: [
      { subjectType: "file_object", subjectId: { in: allFileIds } },
      { subjectType: "store_asset", subjectId: { in: scope.assetIds } },
      {
        subjectType: "ocr_result",
        subjectId: { in: unique([...scope.ocrResultIds, ...ocr.map((row) => row.id)]) },
      },
      { parentType: "store_asset", parentId: { in: scope.assetIds } },
      { parentType: "upload_batch", parentId: { in: batchIds } },
      { parentType: "production_record", parentId: { in: allFileIds } },
      {
        parentType: "playable_asset",
        parentId: { in: unique([...scope.playableAssetIds, ...playables.map((row) => row.id)]) },
      },
    ],
  };
  return {
    ...scope,
    fileIds: allFileIds,
    batchIds,
    relatedIds,
    dramas,
    copyrights,
    permits,
    masters,
    episodes,
    batches,
    batchItems,
    assets,
    playables,
    ocr,
    refs,
    jobWhere,
  };
}

export const M3_JOB_SELECT = {
  id: true,
  kind: true,
  state: true,
  provider: true,
  mode: true,
  subjectType: true,
  subjectId: true,
  parentType: true,
  parentId: true,
  attemptNo: true,
  nextRunAt: true,
  deadlineAt: true,
  errorCode: true,
  isRetryable: true,
  output: true,
} as const;
export async function readM3Facts(tx: Tx, input: M3MediaScope) {
  const scope = await resolveM3Scope(tx, input);
  const [files, metadata, checks, jobs, insights, production, usages, events] = await Promise.all([
    tx.fileObject.findMany({
      where: { id: { in: scope.fileIds } },
      select: {
        id: true,
        status: true,
        category: true,
        bucket: true,
        objectKey: true,
        entityId: true,
        storeId: true,
        sha256: true,
        etag: true,
        sizeBytes: true,
        moderationState: true,
        purgeAfter: true,
        createdAt: true,
        deletedAt: true,
        erasedAt: true,
      },
      orderBy: { id: "asc" },
      take: 513,
    }),
    tx.mediaInfo.findMany({
      where: { fileId: { in: scope.fileIds } },
      select: {
        fileId: true,
        kind: true,
        durationMs: true,
        coverFileId: true,
        aigcMeta: true,
        probedAt: true,
      },
      orderBy: { fileId: "asc" },
      take: 513,
    }),
    tx.mediaCheck.findMany({
      where: { fileId: { in: scope.fileIds } },
      select: { fileId: true, gate: true, profile: true, checkedAt: true },
      orderBy: { fileId: "asc" },
      take: 513,
    }),
    tx.mediaJob.findMany({
      where: scope.jobWhere,
      select: M3_JOB_SELECT,
      orderBy: { id: "asc" },
      take: 513,
    }),
    tx.storeAssetInsight.findMany({
      where: { storeAssetId: { in: scope.assetIds } },
      orderBy: { id: "asc" },
      take: 513,
    }),
    tx.productionRecord.findMany({
      where: { fileId: { in: scope.fileIds } },
      orderBy: { fileId: "asc" },
      take: 513,
    }),
    tx.storeAssetUsage.findMany({
      where: { storeAssetId: { in: scope.assetIds } },
      orderBy: { id: "asc" },
      take: 513,
    }),
    tx.outboxEvent.findMany({
      where: { aggregateId: { in: scope.relatedIds } },
      select: {
        id: true,
        eventType: true,
        aggregateType: true,
        aggregateId: true,
        occurredAt: true,
        publishedAt: true,
      },
      orderBy: { id: "asc" },
      take: 513,
    }),
  ]);
  for (const [label, rows] of Object.entries({
    files,
    metadata,
    checks,
    jobs,
    insights,
    production,
    usages,
    events,
  }))
    bounded(rows, label);
  return {
    counts: {
      dramas: scope.dramas.length,
      copyrights: scope.copyrights.length,
      permits: scope.permits.length,
      episodes: scope.episodes.length,
      masters: scope.masters.length,
      batches: scope.batches.length,
      batchItems: scope.batchItems.length,
      files: files.length,
      metadata: metadata.length,
      checks: checks.length,
      mediaJobs: jobs.length,
      fileRefs: scope.refs.length,
      assets: scope.assets.length,
      insights: insights.length,
      playables: scope.playables.length,
      production: production.length,
      usages: usages.length,
      ocr: scope.ocr.length,
    },
    files,
    metadata,
    checks,
    jobs,
    refs: scope.refs,
    assets: scope.assets,
    insights,
    playables: scope.playables,
    production,
    usages,
    events,
    ocr: scope.ocr.map(({ fieldsEnc, rawEnc, ...row }) => ({
      ...row,
      hasFields: fieldsEnc !== null,
      hasRaw: rawEnc !== null,
    })),
  };
}
