import { createHash } from "node:crypto";
import { Prisma } from "@liyoxi/db";
import type { FileObject, ProductionRecord } from "@liyoxi/db";
import type { ProductionCheckContext } from "@liyoxi/shared";
import { AppError, uuidv7, lockRows, isUuid } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { BoundMediaDeps } from "./context.js";
import type { ProductionWorkFacts } from "./production-types.js";
import { jobBudget } from "./jobs/policy.js";
export const profileOf = (
  category: string,
): "master" | "trailer_src" | "ad" | "sample" | "final" | "asset" =>
  category === "drama_master"
    ? "master"
    : category === "trailer_src"
      ? "trailer_src"
      : category === "ad_video"
        ? "ad"
        : category === "sample_video"
          ? "sample"
          : category === "final_episode"
            ? "final"
            : "asset";
export const contextHash = (record: ProductionRecord | null) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        record
          ? [
              record.kind,
              record.orderItemId,
              record.adId,
              record.episodeNo,
              record.variant,
              record.productionTier,
              record.dramaEpisodeMasterId,
              record.masterSource,
              record.headAdVersionId,
              record.tailAdVersionId,
              record.aiUsage,
            ]
          : null,
      ),
    )
    .digest("hex");
export async function readProductionWork(
  deps: BoundMediaDeps,
  tx: Tx,
  fileId: string,
): Promise<ProductionWorkFacts> {
  const file = await tx.fileObject.findUniqueOrThrow({ where: { id: fileId } });
  const production = await tx.productionRecord.findUnique({ where: { fileId } });
  const parameters = deps.production
    ? await deps.production.parameters(tx)
    : { finalMaxMb: 200, softDurationMs: 180_000, ruleVersion: 1, specVersion: 1 };
  let context: ProductionCheckContext | null = null;
  if (production?.dramaEpisodeMasterId) {
    const master = await deps.production?.readMasterFacts?.(tx, production.dramaEpisodeMasterId);
    const ads =
      production.headAdVersionId || production.tailAdVersionId
        ? await deps.production?.readAdDurations?.(tx, {
            head: production.headAdVersionId,
            tail: production.tailAdVersionId,
          })
        : { headAdMs: 0, tailAdMs: 0 };
    if (
      master &&
      master.durationMs &&
      master.displayWidth &&
      master.displayHeight &&
      ads &&
      typeof production.aiUsage === "object" &&
      production.aiUsage !== null &&
      !Array.isArray(production.aiUsage) &&
      typeof production.aiUsage.used === "boolean"
    )
      context = {
        masterId: master.id,
        masterDurationMs: master.durationMs,
        masterDisplayWidth: master.displayWidth,
        masterDisplayHeight: master.displayHeight,
        headAdMs: ads.headAdMs,
        tailAdMs: ads.tailAdMs,
        aiUsed: production.aiUsage.used,
        masterSource:
          production.masterSource === "current_fallback" ? "current_fallback" : "declared",
        masterIsCurrent: master.isCurrent,
      };
  }
  return { file, production, context, parameters };
}
export async function enqueueProbe(
  deps: BoundMediaDeps,
  tx: Tx,
  fileId: string,
  options: {
    parentBatchId?: string;
    ruleVersion?: number;
  } = {},
): Promise<string> {
  if (
    options.parentBatchId &&
    (!deps.production?.batchConverge ||
      !deps.production.batchNeedsJob ||
      !deps.production.batchLockSiblings)
  )
    throw new AppError("PROVIDER_UNAVAILABLE");
  const file = await tx.fileObject.findUniqueOrThrow({ where: { id: fileId } });
  if (file.status !== "stored" || file.moderationState === "block")
    throw new AppError("FILE_NOT_AVAILABLE");
  const record = await tx.productionRecord.findUnique({ where: { fileId } });
  const ruleVersion =
    options.ruleVersion ?? (await deps.production?.parameters(tx))?.ruleVersion ?? 1;
  if (!Number.isSafeInteger(ruleVersion) || ruleVersion < 1 || ruleVersion > 32767)
    throw new AppError("VALIDATION_FAILED");
  const hash = contextHash(record),
    now = deps.clock.now();
  const dedupeKey = `probe:${fileId}:v${ruleVersion}:${hash}`;
  await tx.mediaJob.createMany({
    data: [
      {
        id: uuidv7(),
        kind: "probe",
        provider: "mediatool",
        mode: "local",
        subjectType: "file_object",
        subjectId: fileId,
        parentType: options.parentBatchId ? "upload_batch" : record ? "production_record" : null,
        parentId: options.parentBatchId ?? record?.fileId ?? null,
        dedupeKey,
        state: "queued",
        input: {
          fileId,
          profile: profileOf(file.category),
          ruleVersion,
          contextHash: hash,
          coverFileId: uuidv7(),
        },
        maxAttempts: 3,
        nextRunAt: now,
        deadlineAt: new Date(now.getTime() + jobBudget("probe")!.deadlineMs),
        createdAt: now,
        updatedAt: now,
      },
    ],
    skipDuplicates: true,
  });
  return (await tx.mediaJob.findUniqueOrThrow({ where: { dedupeKey } })).id;
}
export async function enqueueDerivation(
  deps: BoundMediaDeps,
  tx: Tx,
  fileId: string,
  kind: "restamp" | "normalize",
): Promise<string> {
  const production = deps.production;
  if (!production || (production.mode !== undefined && production.mode !== "full"))
    throw new AppError("PROVIDER_UNAVAILABLE");
  await lockRows(tx, "production_record", [fileId]);
  const record = await tx.productionRecord.findUnique({ where: { fileId } });
  if (!record) throw new AppError("NOT_FOUND");
  const parameters = await production.parameters(tx);
  if (
    !Number.isSafeInteger(parameters.ruleVersion) ||
    parameters.ruleVersion < 1 ||
    parameters.ruleVersion > 32767
  )
    throw new AppError("VALIDATION_FAILED");
  const hash = contextHash(record),
    now = deps.clock.now(),
    destinationFileId = uuidv7();
  const dedupeKey = `${kind}:${fileId}:v${parameters.ruleVersion}:${hash}`;
  await tx.mediaJob.createMany({
    data: [
      {
        id: uuidv7(),
        kind,
        provider: kind === "restamp" ? "mediatool" : production.cloud.status,
        mode: kind === "restamp" ? "local" : "remote",
        subjectType: "file_object",
        subjectId: fileId,
        parentType: "production_record",
        parentId: fileId,
        dedupeKey,
        state: "queued",
        input: {
          fileId,
          destinationFileId,
          contextHash: hash,
          ruleVersion: parameters.ruleVersion,
          objectKey: `derived/${destinationFileId}/${kind}-v${parameters.ruleVersion}.mp4`,
          template: production.config.templates.normalize,
        },
        maxAttempts: 3,
        nextRunAt: now,
        deadlineAt: new Date(now.getTime() + jobBudget(kind)!.deadlineMs),
        createdAt: now,
        updatedAt: now,
      },
    ],
    skipDuplicates: true,
  });
  return (await tx.mediaJob.findUniqueOrThrow({ where: { dedupeKey } })).id;
}
/** Actual technical facts only, bounded at the public edge. */
export async function productionFacts(tx: Tx, fileIds: readonly string[]) {
  if (fileIds.length > 100 || fileIds.some((id) => !isUuid(id)))
    throw new AppError("VALIDATION_FAILED");
  const ids = [...new Set(fileIds)],
    [files, productions, checks, infos, playables] = await Promise.all([
      tx.fileObject.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          status: true,
          moderationState: true,
          category: true,
          uploadBatchId: true,
        },
      }),
      tx.productionRecord.findMany({
        where: { fileId: { in: ids } },
        select: {
          fileId: true,
          kind: true,
          pipelineState: true,
          aigcState: true,
          derivedFromFileId: true,
          dramaEpisodeMasterId: true,
          masterSource: true,
          headAdVersionId: true,
          tailAdVersionId: true,
        },
      }),
      tx.mediaCheck.findMany({
        where: { fileId: { in: ids } },
        select: {
          fileId: true,
          profile: true,
          ruleVersion: true,
          gate: true,
          hard: true,
          soft: true,
        },
      }),
      tx.mediaInfo.findMany({
        where: { fileId: { in: ids } },
        select: {
          fileId: true,
          kind: true,
          durationMs: true,
          displayWidth: true,
          displayHeight: true,
          coverFileId: true,
        },
      }),
      tx.playableAsset.findMany({
        where: {
          sourceFileId: { in: ids },
          kind: "sample",
          state: "ready",
          watermark: { not: Prisma.DbNull },
        },
        select: { sourceFileId: true },
      }),
    ]);
  return ids.map((fileId) => ({
    fileId,
    file: files.find((f) => f.id === fileId) ?? null,
    production: productions.find((r) => r.fileId === fileId) ?? null,
    check: checks.find((c) => c.fileId === fileId) ?? null,
    info: infos.find((i) => i.fileId === fileId) ?? null,
    watermarkReady: playables.some((p) => p.sourceFileId === fileId),
  }));
}
export async function createDerivedFile(
  tx: Tx,
  source: FileObject,
  input: {
    id: string;
    objectKey: string;
    size: number;
    sha256: string;
    etag: string;
    mime?: "video/mp4" | "image/jpeg";
    ext?: "mp4" | "jpg";
  },
  now: Date,
) {
  await tx.fileObject.createMany({
    data: [
      {
        id: input.id,
        bucket: source.bucket,
        objectKey: input.objectKey,
        category: source.category,
        scopeType: source.scopeType,
        entityId: source.entityId,
        storeId: source.storeId,
        uploadBatchId: source.uploadBatchId,
        uploadActorType: "system",
        status: "stored",
        uploadMode: "server",
        declaredSize: input.size,
        declaredMime: input.mime ?? "video/mp4",
        ext: input.ext ?? "mp4",
        sizeBytes: input.size,
        mime: input.mime ?? "video/mp4",
        sha256: input.sha256,
        etag: input.etag,
        storedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ],
    skipDuplicates: true,
  });
  const file = await tx.fileObject.findUniqueOrThrow({ where: { id: input.id } });
  if (
    file.bucket !== source.bucket ||
    file.objectKey !== input.objectKey ||
    file.category !== source.category ||
    file.scopeType !== source.scopeType ||
    file.entityId !== source.entityId ||
    file.storeId !== source.storeId ||
    file.uploadBatchId !== source.uploadBatchId ||
    file.sha256 !== input.sha256 ||
    file.sizeBytes !== BigInt(input.size) ||
    file.etag !== input.etag ||
    file.status !== "stored" ||
    file.mime !== (input.mime ?? "video/mp4") ||
    file.ext !== (input.ext ?? "mp4")
  )
    throw new AppError("STATE_NOT_ALLOWED");
  return file;
}
export const json = (value: unknown) =>
  value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
export const requiredJson = (value: unknown): Prisma.InputJsonValue => {
  if (value === null || value === undefined) throw new AppError("VALIDATION_FAILED");
  return value as Prisma.InputJsonValue;
};
