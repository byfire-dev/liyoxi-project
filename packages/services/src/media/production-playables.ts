import { randomBytes } from "node:crypto";
import { z } from "zod";
import { sampleWatermark } from "@liyoxi/shared";
import { lockRows, uuidv7, AppError, createIdentityContext } from "../kernel/index.js";
import type { ObjectRef, StorageBucket } from "../providers/types.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { BoundMediaDeps } from "./context.js";
import type { MediaConvergenceHandler } from "./jobs/types.js";
import { jobBudget } from "./jobs/policy.js";
import { link, release } from "./refs.js";
export const PlayableInputSchema = z.strictObject({
  fileId: z.uuid(),
  playableAssetId: z.uuid(),
  destinationFileId: z.uuid(),
  quality: z.enum(["sd", "hd", "source"]),
  objectKey: z
    .string()
    .regex(
      /^(?:t\/[0-9a-f-]{36}\/[a-f0-9]{16}\/(?:sd|hd)\.mp4|sample\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp4)$/,
    ),
  scratchKey: z.string().regex(/^ci-out\/[0-9a-f-]{36}\/output\.mp4$/),
  template: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  specVersion: z.number().int().min(1).max(32767),
  aiUsed: z.boolean(),
  watermarks: z
    .array(
      z.union([
        z.strictObject({ templateId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }),
        z.strictObject({
          text: z.string().min(1).max(128),
          position: z.enum(["Center", "TopRight"]),
          fontSize: z.number().int().min(5).max(100),
          transparency: z.number().int().min(1).max(100),
        }),
      ]),
    )
    .max(3),
});
export const RenditionSchema = z.strictObject({
  quality: z.enum(["sd", "hd", "source"]),
  fileId: z.uuid(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bitrateKbps: z.number().int().nonnegative().nullable(),
});
/** Caller holds the parent domain; prelock existing assets before production/file locks. */
export async function enqueueTrailer(
  deps: BoundMediaDeps,
  tx: Tx,
  input: { dramaId: string; fileId: string; staffId: string },
): Promise<readonly string[]> {
  if (!deps.production?.readTrailerFacts || !deps.production.setTrailerTarget)
    throw new AppError("PROVIDER_UNAVAILABLE");
  const [drama, file, checked, info] = await Promise.all([
    deps.production.readTrailerFacts(tx, input.dramaId),
    tx.fileObject.findUnique({ where: { id: input.fileId } }),
    tx.mediaCheck.findUnique({ where: { fileId: input.fileId } }),
    tx.mediaInfo.findUnique({ where: { fileId: input.fileId } }),
  ]);
  if (
    !drama ||
    !file ||
    file.status !== "stored" ||
    file.category !== "trailer_src" ||
    file.scopeType !== "platform" ||
    file.moderationState === "block"
  )
    throw new AppError("FILE_NOT_USABLE", {
      details: {
        fileIds: [input.fileId],
        reason:
          !file || file.status !== "stored"
            ? "not_stored"
            : file.moderationState === "block"
              ? "blocked"
              : "category_mismatch",
      },
    });
  if (!checked)
    throw new AppError("TRAILER_SOURCE_CHECKING", { details: { sourceFileId: input.fileId } });
  if (
    checked.profile !== "trailer_src" ||
    checked.gate !== "pass" ||
    !info?.durationMs ||
    info.durationMs > 180000
  )
    throw new AppError("TRAILER_SOURCE_REJECTED", {
      details: { reason: "rejected", failed: checked.hard },
    });
  const { specVersion } = await deps.production.parameters(tx),
    now = deps.clock.now();
  if (!Number.isSafeInteger(specVersion) || specVersion < 1 || specVersion > 32767)
    throw new AppError("VALIDATION_FAILED");
  const existing = await tx.playableAsset.findUnique({
    where: {
      kind_sourceFileId_specVersion: { kind: "trailer", sourceFileId: file.id, specVersion },
    },
  });
  if (!existing)
    await tx.playableAsset.createMany({
      data: [
        {
          id: uuidv7(),
          kind: "trailer",
          sourceFileId: file.id,
          ownerType: "drama",
          ownerId: drama.dramaId,
          state: "processing",
          specVersion,
          coverFileId: drama.posterFileId,
          createdAt: now,
          updatedAt: now,
        },
      ],
      skipDuplicates: true,
    });
  const playable = await tx.playableAsset.findUniqueOrThrow({
    where: {
      kind_sourceFileId_specVersion: { kind: "trailer", sourceFileId: file.id, specVersion },
    },
  });
  const locked = [playable.id, drama.targetPlayableAssetId, drama.currentPlayableAssetId].filter(
    (id): id is string => !!id,
  );
  await lockRows(tx, "playable_asset", locked);
  const current = await deps.production.readTrailerFacts(tx, input.dramaId);
  if (
    !current ||
    [current.targetPlayableAssetId, current.currentPlayableAssetId].some(
      (id) => id && !locked.includes(id),
    )
  )
    throw new AppError("BUSY");
  if (
    playable.ownerId !== drama.dramaId ||
    playable.ownerType !== "drama" ||
    playable.state === "retired"
  ) {
    if (playable.state === "retired")
      throw new AppError("TRAILER_SOURCE_REJECTED", { details: { reason: "retired" } });
    throw new AppError("STATE_NOT_ALLOWED");
  }
  await deps.production.setTrailerTarget(tx, {
    dramaId: drama.dramaId,
    playableAssetId: playable.id,
    staffId: input.staffId,
    now,
  });
  if (existing)
    return (
      await tx.mediaJob.findMany({
        where: { parentType: "playable_asset", parentId: playable.id, kind: "transcode_mp4" },
        select: { id: true },
        orderBy: { id: "asc" },
      })
    ).map((v) => v.id);
  const ids: string[] = [],
    nonce = randomBytes(8).toString("hex");
  for (const quality of ["sd", "hd"] as const) {
    const id = uuidv7(),
      destinationFileId = uuidv7(),
      dedupeKey = `transcode_mp4:${playable.id}:${quality}:v${specVersion}`;
    await tx.mediaJob.createMany({
      data: [
        {
          id,
          kind: "transcode_mp4",
          mode: "remote",
          provider: deps.production.cloud.status,
          subjectType: "file_object",
          subjectId: file.id,
          parentType: "playable_asset",
          parentId: playable.id,
          dedupeKey,
          input: {
            fileId: file.id,
            playableAssetId: playable.id,
            destinationFileId,
            quality,
            objectKey: `t/${drama.dramaId}/${nonce}/${quality}.mp4`,
            scratchKey: `ci-out/${id}/output.mp4`,
            template: deps.production.config.templates[quality],
            specVersion,
            aiUsed: drama.isAiGenerated,
            watermarks: [
              { templateId: deps.production.config.templates.brand },
              ...(drama.isAiGenerated ? [{ templateId: deps.production.config.templates.ai }] : []),
            ],
          },
          state: "queued",
          maxAttempts: 3,
          nextRunAt: now,
          deadlineAt: new Date(now.getTime() + jobBudget("transcode_mp4")!.deadlineMs),
          createdAt: now,
          updatedAt: now,
        },
      ],
      skipDuplicates: true,
    });
    ids.push((await tx.mediaJob.findUniqueOrThrow({ where: { dedupeKey } })).id);
  }
  await lockRows(tx, "file_object", [
    file.id,
    ...(playable.coverFileId ? [playable.coverFileId] : []),
  ]);
  await link(deps, tx, {
    fileId: file.id,
    entityId: null,
    storeId: null,
    refType: "playable_asset",
    refId: playable.id,
    role: "source",
  });
  if (playable.coverFileId)
    await link(deps, tx, {
      fileId: playable.coverFileId,
      entityId: null,
      storeId: null,
      refType: "playable_asset",
      refId: playable.id,
      role: "cover",
    });
  return ids;
}
/** Called only after a real check passed; does not upgrade an M1 raw playable into a watermarked fact. */
export async function enqueueSampleWatermark(
  deps: BoundMediaDeps,
  tx: Tx,
  fileId: string,
): Promise<string> {
  if (!deps.production) throw new AppError("PROVIDER_UNAVAILABLE");
  const [file, record, check] = await Promise.all([
    tx.fileObject.findUnique({ where: { id: fileId } }),
    tx.productionRecord.findUnique({ where: { fileId } }),
    tx.mediaCheck.findUnique({ where: { fileId } }),
  ]);
  if (
    !file?.storeId ||
    file.status !== "stored" ||
    file.category !== "sample_video" ||
    !record?.orderItemId ||
    check?.gate !== "pass"
  )
    throw new AppError("FILE_NOT_AVAILABLE");
  const store = await deps.production.readStoreFacts(tx, file.storeId);
  if (!store) throw new AppError("PROVIDER_UNAVAILABLE");
  const { specVersion } = await deps.production.parameters(tx),
    now = deps.clock.now(),
    orderItemId = record.orderItemId;
  if (!Number.isSafeInteger(specVersion) || specVersion < 1 || specVersion > 32767)
    throw new AppError("VALIDATION_FAILED");
  const existing = await tx.playableAsset.findUnique({
    where: {
      kind_sourceFileId_specVersion: { kind: "sample", sourceFileId: file.id, specVersion },
    },
  });
  // The production parent lock serializes creators. Never adopt a competing, unprelocked asset after job/file locks.
  const playable =
    existing ??
    (await tx.playableAsset.create({
      data: {
        id: uuidv7(),
        kind: "sample",
        sourceFileId: file.id,
        entityId: file.entityId,
        storeId: file.storeId,
        ownerType: "order_item",
        ownerId: orderItemId,
        state: "processing",
        specVersion,
        createdAt: now,
        updatedAt: now,
      },
    }));
  if (
    playable.ownerType !== "order_item" ||
    playable.ownerId !== orderItemId ||
    playable.entityId !== file.entityId ||
    playable.storeId !== file.storeId ||
    playable.state === "retired"
  )
    throw new AppError("STATE_NOT_ALLOWED");
  const id = uuidv7(),
    destinationFileId = uuidv7(),
    text = sampleWatermark(store.name, now),
    dedupeKey = `watermark_sample:${playable.id}:v${specVersion}`;
  await tx.mediaJob.createMany({
    data: [
      {
        id,
        kind: "watermark_sample",
        mode: "remote",
        provider: deps.production.cloud.status,
        subjectType: "file_object",
        subjectId: file.id,
        parentType: "playable_asset",
        parentId: playable.id,
        dedupeKey,
        input: {
          fileId: file.id,
          playableAssetId: playable.id,
          destinationFileId,
          quality: "source",
          objectKey: `sample/${playable.id}/${destinationFileId}.mp4`,
          scratchKey: `ci-out/${id}/output.mp4`,
          template: deps.production.config.templates.sample,
          specVersion,
          aiUsed: (record.aiUsage as { used?: boolean }).used === true,
          watermarks: [{ text, position: "Center", fontSize: 36, transparency: 30 }],
        },
        state: "queued",
        maxAttempts: 3,
        nextRunAt: now,
        deadlineAt: new Date(now.getTime() + jobBudget("watermark_sample")!.deadlineMs),
        createdAt: now,
        updatedAt: now,
      },
    ],
    skipDuplicates: true,
  });
  return (await tx.mediaJob.findUniqueOrThrow({ where: { dedupeKey } })).id;
}
export async function playableCurrent(
  tx: Tx,
  job: Parameters<MediaConvergenceHandler["needed"]>[1],
) {
  const input = PlayableInputSchema.safeParse(job.input);
  if (
    !input.success ||
    job.parentId !== input.data.playableAssetId ||
    job.parentType !== "playable_asset"
  )
    return false;
  const [asset, file] = await Promise.all([
    tx.playableAsset.findUnique({ where: { id: input.data.playableAssetId } }),
    tx.fileObject.findUnique({ where: { id: job.subjectId } }),
  ]);
  return (
    !!asset &&
    asset.sourceFileId === input.data.fileId &&
    asset.specVersion === input.data.specVersion &&
    asset.kind === (job.kind === "watermark_sample" ? "sample" : "trailer") &&
    file?.category === (job.kind === "watermark_sample" ? "sample_video" : "trailer_src") &&
    job.dedupeKey ===
      (job.kind === "watermark_sample"
        ? `watermark_sample:${asset.id}:v${asset.specVersion}`
        : `transcode_mp4:${asset.id}:${input.data.quality}:v${asset.specVersion}`) &&
    input.data.scratchKey === `ci-out/${job.id}/output.mp4` &&
    (job.kind === "watermark_sample"
      ? input.data.objectKey === `sample/${asset.id}/${input.data.destinationFileId}.mp4`
      : input.data.objectKey.startsWith(`t/${asset.ownerId}/`) &&
        input.data.objectKey.endsWith(`/${input.data.quality}.mp4`)) &&
    (asset.state === "processing" ||
      (job.kind === "watermark_sample" && asset.state === "ready" && asset.watermark === null)) &&
    file?.status === "stored" &&
    file.moderationState !== "block"
  );
}
async function releasePlayableRefs(deps: BoundMediaDeps, tx: Tx, id: string, now: Date) {
  const asset = await tx.playableAsset.findUniqueOrThrow({ where: { id } });
  const refs = await tx.fileRef.findMany({
    where: { refType: "playable_asset", refId: id, state: "live" },
  });
  await lockRows(
    tx,
    "file_object",
    refs.map((r) => r.fileId),
  );
  for (const ref of refs)
    await release(deps, tx, {
      fileId: ref.fileId,
      entityId: asset.entityId,
      storeId: asset.storeId,
      refType: "playable_asset",
      refId: id,
      role: ref.role,
      keepUntil: new Date(now.getTime() + 30 * 86_400_000),
    });
}
export async function retirePlayable(deps: BoundMediaDeps, tx: Tx, id: string, now: Date) {
  const asset = await tx.playableAsset.findUnique({ where: { id } });
  if (!asset || asset.state === "retired") return;
  await tx.playableAsset.update({
    where: { id },
    data: { state: "retired", retiredAt: now, updatedAt: now },
  });
  await releasePlayableRefs(deps, tx, id, now);
}
/** Copyright-only path. Caller owns the drama transaction; it does not assert CDN invalidation. */
export async function retireDramaMedia(
  deps: BoundMediaDeps,
  tx: Tx,
  dramaId: string,
  input: { scope: "trailer"; immediate: true } | { scope: "masters" },
): Promise<{
  objectRefs: readonly ObjectRef[];
  cdnPending: true;
}> {
  if (input.scope === "masters") {
    const masters = await tx.dramaEpisodeMaster.findMany({
      where: { dramaId },
      select: { id: true },
    });
    const refs = await tx.fileRef.findMany({
      where: {
        refType: "drama_episode_master",
        refId: { in: masters.map((v) => v.id) },
        role: "main",
        state: "live",
      },
    });
    await lockRows(
      tx,
      "file_object",
      refs.map((v) => v.fileId),
    );
    const now = deps.clock.now(),
      keep = new Date(now.getTime() + 90 * 86400000);
    for (const ref of refs)
      await tx.fileRef.update({
        where: { id: ref.id },
        data: {
          state: "released",
          releasedAt: now,
          keepUntil: new Date(Math.max(keep.getTime(), ref.keepUntil?.getTime() ?? 0)),
          updatedAt: now,
        },
      });
    for (const id of new Set(refs.map((v) => v.fileId))) {
      const remaining = await tx.fileRef.findMany({
        where: { fileId: id },
        select: { state: true, keepUntil: true },
      });
      await tx.fileObject.update({
        where: { id },
        data: {
          purgeAfter: remaining.some((v) => v.state === "live")
            ? null
            : new Date(
                Math.max(now.getTime(), ...remaining.map((v) => v.keepUntil?.getTime() ?? 0)),
              ),
          updatedAt: now,
        },
      });
    }
    return { objectRefs: [], cdnPending: true };
  }
  if (input.scope !== "trailer" || input.immediate !== true)
    throw new AppError("VALIDATION_FAILED");
  const before = await tx.playableAsset.findMany({
    where: { ownerType: "drama", ownerId: dramaId, kind: "trailer" },
    select: { id: true },
  });
  await lockRows(
    tx,
    "playable_asset",
    before.map((one) => one.id),
  );
  const assets = await tx.playableAsset.findMany({
    where: { ownerType: "drama", ownerId: dramaId, kind: "trailer" },
    select: { id: true },
  });
  if (assets.some((one) => !before.some((old) => old.id === one.id))) throw new AppError("BUSY");
  const ids = assets.map((one) => one.id),
    jobs = await tx.mediaJob.findMany({
      where: {
        parentType: "playable_asset",
        parentId: { in: ids },
        state: { in: ["queued", "running", "submitting", "submitted"] },
      },
      select: { id: true },
    });
  await lockRows(
    tx,
    "media_job",
    jobs.map((one) => one.id),
  );
  const refs = await tx.fileRef.findMany({
    where: { refType: "playable_asset", refId: { in: ids } },
    select: { fileId: true, id: true },
  });
  const fileIds = [...new Set(refs.map((one) => one.fileId))];
  await lockRows(tx, "file_object", fileIds);
  const now = deps.clock.now();
  await tx.playableAsset.updateMany({
    where: { id: { in: ids }, state: { not: "retired" } },
    data: { state: "retired", retiredAt: now, updatedAt: now },
  });
  await tx.mediaJob.updateMany({
    where: {
      id: { in: jobs.map((one) => one.id) },
      state: { in: ["queued", "running", "submitting", "submitted"] },
    },
    data: { state: "canceled", finishedAt: now, leaseOwner: null, updatedAt: now },
  });
  await tx.fileRef.updateMany({
    where: { id: { in: refs.map((one) => one.id) } },
    data: { state: "released", releasedAt: now, keepUntil: now, updatedAt: now },
  });
  for (const fileId of fileIds) {
    const remaining = await tx.fileRef.findMany({
      where: { fileId },
      select: { state: true, keepUntil: true },
    });
    await tx.fileObject.update({
      where: { id: fileId },
      data: {
        purgeAfter: remaining.some((one) => one.state === "live")
          ? null
          : new Date(
              Math.max(now.getTime(), ...remaining.map((one) => one.keepUntil?.getTime() ?? 0)),
            ),
        updatedAt: now,
      },
    });
  }
  const files = await tx.fileObject.findMany({
    where: { id: { in: fileIds } },
    select: { bucket: true, objectKey: true },
  });
  return {
    objectRefs: files.map((one) => ({ bucket: one.bucket as StorageBucket, key: one.objectKey })),
    cdnPending: true,
  };
}
export function createProductionConvergence(deps: BoundMediaDeps): MediaConvergenceHandler[] {
  const ctx = createIdentityContext({ actor: { type: "system", job: "media_job_run" } });
  const emit = async (
    tx: Tx,
    id: string,
    type: "media.playable.ready" | "media.playable.failed",
    identity: IdentityContext = ctx,
  ) => {
    const asset = await tx.playableAsset.findUniqueOrThrow({ where: { id } });
    await deps.events.emit(tx, identity, {
      type,
      aggregate: { type: "playable_asset", id },
      entityId: asset.entityId,
      storeId: asset.storeId,
      payload: {
        v: 1,
        playableAssetId: id,
        ownerType: asset.ownerType,
        ownerId: asset.ownerId,
        kind: asset.kind as "trailer" | "sample" | "ad",
      },
      dedupeKey: id,
    });
  };
  return [
    {
      parentType: "production_record",
      lockSiblings: async (tx, id) => {
        const file = await tx.fileObject.findUnique({
          where: { id },
          select: { uploadBatchId: true },
        });
        if (file?.uploadBatchId) {
          if (!deps.production?.batchLockSiblings) throw new AppError("PROVIDER_UNAVAILABLE");
          await deps.production.batchLockSiblings(tx, file.uploadBatchId);
          return;
        }
        const before = await tx.playableAsset.findMany({
          where: { kind: "sample", sourceFileId: id },
          select: { id: true },
        });
        await lockRows(
          tx,
          "playable_asset",
          before.map((one) => one.id),
        );
        await lockRows(tx, "production_record", [id]);
        const after = await tx.playableAsset.findMany({
          where: { kind: "sample", sourceFileId: id },
          select: { id: true },
        });
        if (after.some((one) => !before.some((old) => old.id === one.id)))
          throw new AppError("BUSY");
      },
      needed: async (tx, job) => {
        const [record, file] = await Promise.all([
          tx.productionRecord.findUnique({ where: { fileId: job.parentId! } }),
          tx.fileObject.findUnique({ where: { id: job.subjectId } }),
        ]);
        if (!record || file?.status !== "stored" || file.moderationState === "block") return false;
        return (
          !file.uploadBatchId ||
          (await deps.production?.batchNeedsJob?.(tx, {
            batchId: file.uploadBatchId,
            fileId: file.id,
          })) === true
        );
      },
      converge: async () => {},
    },
    {
      parentType: "upload_batch",
      lockSiblings: async (tx, id) => {
        if (!deps.production?.batchLockSiblings) throw new AppError("PROVIDER_UNAVAILABLE");
        await deps.production.batchLockSiblings(tx, id);
      },
      needed: (tx, job) =>
        deps.production?.batchNeedsJob?.(tx, { batchId: job.parentId!, fileId: job.subjectId }) ??
        Promise.resolve(false),
      converge: (tx, id, now) => deps.production?.batchConverge?.(tx, id, now) ?? Promise.resolve(),
    },
    {
      parentType: "playable_asset",
      lockSiblings: async (tx, id) => {
        const asset = await tx.playableAsset.findUnique({ where: { id } });
        if (asset?.kind !== "trailer") {
          await lockRows(tx, "playable_asset", [id]);
          return;
        }
        if (!deps.production?.readTrailerFacts) throw new AppError("PROVIDER_UNAVAILABLE");
        const before = await deps.production.readTrailerFacts(tx, asset.ownerId);
        const locked = [id, before?.targetPlayableAssetId, before?.currentPlayableAssetId].filter(
          (one): one is string => !!one,
        );
        await lockRows(tx, "playable_asset", locked);
        const after = await deps.production.readTrailerFacts(tx, asset.ownerId);
        if (
          [after?.targetPlayableAssetId, after?.currentPlayableAssetId].some(
            (one) => one && !locked.includes(one),
          )
        )
          throw new AppError("BUSY");
      },
      needed: async (tx, job) => {
        if (!(await playableCurrent(tx, job))) return false;
        const asset = await tx.playableAsset.findUniqueOrThrow({ where: { id: job.parentId! } });
        return (
          asset.kind !== "trailer" ||
          (await deps.production?.readTrailerFacts?.(tx, asset.ownerId))?.targetPlayableAssetId ===
            asset.id
        );
      },
      converge: async (tx, id, now) => {
        const asset = await tx.playableAsset.findUnique({ where: { id } });
        if (!asset || asset.state === "retired" || asset.state === "failed") return;
        if (
          asset.kind === "trailer" &&
          (await deps.production?.readTrailerFacts?.(tx, asset.ownerId))?.targetPlayableAssetId !==
            id
        ) {
          await retirePlayable(deps, tx, id, now);
          return;
        }
        const jobs = await tx.mediaJob.findMany({
          where: {
            parentType: "playable_asset",
            parentId: id,
            kind: { in: ["transcode_mp4", "watermark_sample"] },
          },
        });
        if (jobs.some((j) => ["queued", "running", "submitted", "submitting"].includes(j.state)))
          return;
        if (jobs.length === 0 || jobs.some((j) => j.state !== "succeeded")) {
          await tx.playableAsset.update({
            where: { id },
            data: { state: "failed", error: "媒体任务未完成", updatedAt: now },
          });
          await releasePlayableRefs(deps, tx, id, now);
          await emit(tx, id, "media.playable.failed");
          return;
        }
        const renditions = z.array(RenditionSchema).max(2).safeParse(asset.renditions);
        if (
          !renditions.success ||
          (asset.kind === "trailer"
            ? renditions.data.length !== 2 ||
              !["sd", "hd"].every((q) => renditions.data.some((r) => r.quality === q))
            : renditions.data.length !== 1 || asset.watermark === null)
        )
          return;
        if (asset.kind === "trailer") {
          if (!deps.production?.readTrailerFacts || !deps.production.installTrailerCurrent)
            throw new AppError("PROVIDER_UNAVAILABLE");
          const pointer = await deps.production.readTrailerFacts(tx, asset.ownerId);
          if (!pointer || pointer.targetPlayableAssetId !== id) {
            await retirePlayable(deps, tx, id, now);
            return;
          }
          const installed = await deps.production.installTrailerCurrent(tx, {
            dramaId: asset.ownerId,
            playableAssetId: id,
            now,
          });
          if (!installed.changed) {
            await retirePlayable(deps, tx, id, now);
            return;
          }
          if (installed.oldCurrentPlayableAssetId && installed.oldCurrentPlayableAssetId !== id)
            await retirePlayable(deps, tx, installed.oldCurrentPlayableAssetId, now);
          await deps.events.emit(tx, ctx, {
            type: "drama.trailer_ready",
            aggregate: { type: "drama", id: asset.ownerId },
            payload: { v: 1, dramaId: asset.ownerId, playableAssetId: id },
            dedupeKey: id,
          });
        }
        await tx.playableAsset.update({
          where: { id },
          data: { state: "ready", readyAt: now, updatedAt: now },
        });
        await emit(tx, id, "media.playable.ready");
      },
    },
  ];
}
