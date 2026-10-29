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
import { contextHash, manualDerivationTarget } from "./production.js";
import { DerivationInputSchema, ProbeInputSchema } from "./production-job-schemas.js";
import { deliveryProductionFacts } from "./production/facts.js";
import {
  LocalSamplePlayableInputSchema,
  PlayableInputSchema,
  RenditionSchema,
} from "./playable-schemas.js";
export {
  CloudPlayableInputSchema,
  LocalSamplePlayableInputSchema,
  PlayableInputSchema,
  PlayableOutputSchema,
  RenditionSchema,
} from "./playable-schemas.js";
/** Caller holds the parent domain; prelock existing assets before production/file locks. */
export async function enqueueTrailer(
  deps: BoundMediaDeps,
  tx: Tx,
  input: { dramaId: string; fileId: string; staffId: string },
): Promise<readonly string[]> {
  const production = deps.production;
  if (
    !production ||
    (production.mode !== undefined && production.mode !== "full") ||
    !production.readTrailerFacts ||
    !production.setTrailerTarget
  )
    throw new AppError("PROVIDER_UNAVAILABLE");
  const [drama, file, checked, info] = await Promise.all([
    production.readTrailerFacts(tx, input.dramaId),
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
  const { specVersion } = await production.parameters(tx),
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
  const current = await production.readTrailerFacts(tx, input.dramaId);
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
  await production.setTrailerTarget(tx, {
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
          provider: production.cloud.status,
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
            template: production.config.templates[quality],
            specVersion,
            aiUsed: drama.isAiGenerated,
            watermarks: [
              { templateId: production.config.templates.brand },
              ...(drama.isAiGenerated ? [{ templateId: production.config.templates.ai }] : []),
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
  const production = deps.production;
  if (!production || production.mode === "probe_only") throw new AppError("PROVIDER_UNAVAILABLE");
  const local = production.mode === "local_sample_watermark";
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
  if (local) {
    const actual = await deliveryProductionFacts(deps, tx, fileId);
    const info = await tx.mediaInfo.findUnique({ where: { fileId } });
    if (
      !production.tool.watermarkSample ||
      !actual.ready ||
      (record.aiUsage as { used?: boolean }).used !== false ||
      record.aigcState !== "not_required" ||
      !file.sha256 ||
      info?.aigcMeta !== null
    )
      throw new AppError("PROVIDER_UNAVAILABLE");
  }
  const store = await production.readStoreFacts(tx, file.storeId);
  if (!store) throw new AppError("PROVIDER_UNAVAILABLE");
  const { specVersion, ruleVersion } = await production.parameters(tx),
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
        mode: local ? "local" : "remote",
        provider: local ? "mediatool" : production.cloud.status,
        subjectType: "file_object",
        subjectId: file.id,
        parentType: "playable_asset",
        parentId: playable.id,
        dedupeKey,
        input: local
          ? LocalSamplePlayableInputSchema.parse({
              execution: "local",
              fileId: file.id,
              playableAssetId: playable.id,
              destinationFileId,
              quality: "source",
              objectKey: `sample/${playable.id}/${destinationFileId}.mp4`,
              specVersion,
              ruleVersion,
              sourceSha256: file.sha256,
              contextHash: contextHash(record),
              recipe: "sample_center_v1",
              aiUsed: false,
              watermarks: [{ text, position: "Center" }],
            })
          : {
              fileId: file.id,
              playableAssetId: playable.id,
              destinationFileId,
              quality: "source",
              objectKey: `sample/${playable.id}/${destinationFileId}.mp4`,
              scratchKey: `ci-out/${id}/output.mp4`,
              template: production.config.templates.sample,
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
  const job = await tx.mediaJob.findUniqueOrThrow({ where: { dedupeKey } });
  if (
    local &&
    (job.mode !== "local" ||
      job.provider !== "mediatool" ||
      !LocalSamplePlayableInputSchema.safeParse(job.input).success)
  )
    throw new AppError("STATE_NOT_ALLOWED");
  return job.id;
}
export async function playableCurrent(
  tx: Tx,
  job: Parameters<MediaConvergenceHandler["needed"]>[1],
  options: { allowLocalFailed?: boolean } = {},
) {
  const input = PlayableInputSchema.safeParse(job.input);
  if (
    !input.success ||
    job.parentId !== input.data.playableAssetId ||
    job.parentType !== "playable_asset"
  )
    return false;
  const local = LocalSamplePlayableInputSchema.safeParse(job.input).success;
  if (
    local &&
    (job.kind !== "watermark_sample" ||
      job.mode !== "local" ||
      job.provider !== "mediatool" ||
      job.externalJobId !== null)
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
    (local ||
      ("scratchKey" in input.data && input.data.scratchKey === `ci-out/${job.id}/output.mp4`)) &&
    (job.kind === "watermark_sample"
      ? input.data.objectKey === `sample/${asset.id}/${input.data.destinationFileId}.mp4`
      : input.data.objectKey.startsWith(`t/${asset.ownerId}/`) &&
        input.data.objectKey.endsWith(`/${input.data.quality}.mp4`)) &&
    (asset.state === "processing" ||
      (local && options.allowLocalFailed && job.state === "failed" && asset.state === "failed") ||
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
        const record = await tx.productionRecord.findUnique({ where: { fileId: id } });
        const related = [id, ...(record?.derivedFromFileId ? [record.derivedFromFileId] : [])];
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
          where: { kind: "sample", sourceFileId: { in: related } },
          select: { id: true },
        });
        await lockRows(
          tx,
          "playable_asset",
          before.map((one) => one.id),
        );
        await lockRows(tx, "production_record", related);
        const after = await tx.playableAsset.findMany({
          where: { kind: "sample", sourceFileId: { in: related } },
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
        const parsed = DerivationInputSchema.safeParse(job.input);
        if (parsed.success && parsed.data.manual) {
          const source = await tx.productionRecord.findUnique({ where: { fileId: file.id } });
          return !!source && !!(await manualDerivationTarget(tx, job, parsed.data, file, source));
        }
        const probe = ProbeInputSchema.safeParse(job.input);
        if (
          job.kind === "probe" &&
          job.parentId === file.id &&
          probe.success &&
          job.dedupeKey ===
            `probe:${file.id}:v${probe.data.ruleVersion}:${probe.data.contextHash}:manual:${job.id}`
        )
          return probe.data.fileId === file.id && probe.data.contextHash === contextHash(record);
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
          if (asset?.kind === "sample" && deps.production?.mode === "local_sample_watermark")
            await lockRows(tx, "production_record", [asset.sourceFileId]);
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
        const allowLocalFailed =
          deps.production?.mode === "local_sample_watermark" && job.state === "failed";
        if (!(await playableCurrent(tx, job, { allowLocalFailed }))) return false;
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
