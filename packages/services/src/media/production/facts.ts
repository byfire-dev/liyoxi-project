import { z } from "zod";
import { checkProduction } from "@liyoxi/shared";
import { AppError, isUuid } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { BoundMediaDeps } from "../context.js";
import { contextHash, profileOf, readProductionWork } from "../production.js";
import { LabelSchema, checkFacts } from "../production-report.js";
import {
  ProbeInputSchema,
  ProbeOutputSchema,
  DerivationInputSchema,
  DerivationOutputSchema,
} from "../production-job-schemas.js";
import {
  CloudPlayableInputSchema,
  LocalSamplePlayableInputSchema,
  PlayableInputSchema,
  PlayableOutputSchema,
  RenditionSchema,
  localSampleOutputValid,
} from "../playable-schemas.js";

const cloudOutput = PlayableOutputSchema;
/** Revalidate successful job output against the caller transaction's current context and rows. */
export async function deliveryProductionFacts(deps: BoundMediaDeps, tx: Tx, fileId: string) {
  if (!isUuid(fileId)) throw new AppError("VALIDATION_FAILED");
  const facts = await readProductionWork(deps, tx, fileId);
  const { production: record, file, context, parameters } = facts;
  const [check, info, job] = await Promise.all([
    tx.mediaCheck.findUnique({ where: { fileId } }),
    tx.mediaInfo.findUnique({ where: { fileId } }),
    tx.mediaJob.findUnique({
      where: { dedupeKey: `probe:${fileId}:v${parameters.ruleVersion}:${contextHash(record)}` },
    }),
  ]);
  const output = ProbeOutputSchema.safeParse(job?.output);
  const probeInput = ProbeInputSchema.safeParse(job?.input);
  const expected = context
    ? {
        masterId: context.masterId,
        masterDurationMs: context.masterDurationMs,
        masterDisplayWidth: context.masterDisplayWidth,
        masterDisplayHeight: context.masterDisplayHeight,
        headAdMs: context.headAdMs,
        tailAdMs: context.tailAdMs,
        aiUsed: context.aiUsed,
      }
    : null;
  const snapshot = check?.contextSnapshot;
  const contextMatches = expected
    ? !!snapshot &&
      typeof snapshot === "object" &&
      !Array.isArray(snapshot) &&
      Object.keys(snapshot).length === 7 &&
      Object.entries(expected).every(([key, value]) => snapshot[key] === value)
    : snapshot === null;
  const recomputed = output.success
    ? checkProduction(checkFacts(output.data.technical), context, parameters)
    : null;
  const technical =
    !!record &&
    !!check &&
    !!info &&
    !!job &&
    output.success &&
    contextMatches &&
    file.status === "stored" &&
    file.moderationState !== "block" &&
    file.sha256 === output.data.sourceSha256 &&
    file.sizeBytes === BigInt(output.data.technical.sizeBytes) &&
    check.profile === profileOf(file.category) &&
    check.ruleVersion === parameters.ruleVersion &&
    check.gate === recomputed?.gate &&
    job.state === "succeeded" &&
    job.kind === "probe" &&
    job.subjectType === "file_object" &&
    job.subjectId === fileId &&
    job.provider === "mediatool" &&
    job.mode === "local" &&
    probeInput.success &&
    probeInput.data.fileId === fileId &&
    probeInput.data.profile === profileOf(file.category) &&
    probeInput.data.ruleVersion === parameters.ruleVersion &&
    probeInput.data.contextHash === contextHash(record) &&
    job.finishedAt?.getTime() === check.checkedAt.getTime() &&
    info.probedAt.getTime() === check.checkedAt.getTime() &&
    info.durationMs === output.data.technical.durationMs &&
    info.displayWidth === output.data.technical.displayWidth &&
    info.displayHeight === output.data.technical.displayHeight;
  const aiUsed = context?.aiUsed === true;
  const aiVerified = aiUsed
    ? record?.aigcState === "verified" && LabelSchema.safeParse(info?.aigcMeta).success
    : record?.aigcState === "not_required";
  let provenance = record?.source === "manual_upload" && record.derivedFromFileId === null;
  if (record?.derivedFromFileId && ["normalized", "restamped"].includes(record.source)) {
    const [origin, source] = await Promise.all([
      tx.fileObject.findUnique({ where: { id: record.derivedFromFileId } }),
      tx.productionRecord.findUnique({ where: { fileId: record.derivedFromFileId } }),
    ]);
    const kind = record.source === "restamped" ? "restamp" : "normalize";
    const derived = await tx.mediaJob.findUnique({
      where: {
        dedupeKey: `${kind}:${record.derivedFromFileId}:v${parameters.ruleVersion}:${contextHash(source)}`,
      },
    });
    const input = DerivationInputSchema.safeParse(derived?.input);
    const result =
      kind === "restamp"
        ? DerivationOutputSchema.safeParse(derived?.output)
        : cloudOutput.safeParse(derived?.output);
    provenance =
      !!origin &&
      !!source &&
      origin.status === "stored" &&
      origin.moderationState !== "block" &&
      origin.id !== file.id &&
      origin.entityId === file.entityId &&
      origin.storeId === file.storeId &&
      origin.category === file.category &&
      !!origin.sha256 &&
      !!origin.sizeBytes &&
      contextHash(source) === contextHash(record) &&
      derived?.state === "succeeded" &&
      derived.kind === kind &&
      derived.subjectType === "file_object" &&
      derived.subjectId === origin.id &&
      derived.parentType === "production_record" &&
      derived.parentId === origin.id &&
      (kind !== "restamp" || (derived.provider === "mediatool" && derived.mode === "local")) &&
      input.success &&
      input.data.fileId === origin.id &&
      input.data.destinationFileId === file.id &&
      input.data.contextHash === contextHash(record) &&
      input.data.ruleVersion === parameters.ruleVersion &&
      result.success &&
      result.data.fileId === file.id &&
      result.data.sha256 === file.sha256 &&
      BigInt(result.data.size) === file.sizeBytes;
  }
  const valid = technical && provenance;
  const ready =
    valid &&
    !!context &&
    aiVerified &&
    record?.pipelineState === "ready" &&
    check?.gate === "pass" &&
    Number.isSafeInteger(info?.durationMs) &&
    info!.durationMs! > 0;
  let awaitingRestamp = false;
  if (
    valid &&
    context?.aiUsed &&
    recomputed?.hard.filter((row) => !row.pass).every((row) => row.code === "H7") &&
    recomputed.gate === "reject" &&
    output.success &&
    !output.data.technical.invalidAigc &&
    output.data.technical.aigcMeta === null
  ) {
    const restamp = await tx.mediaJob.findUnique({
      where: { dedupeKey: `restamp:${fileId}:v${parameters.ruleVersion}:${contextHash(record)}` },
    });
    const input = DerivationInputSchema.safeParse(restamp?.input);
    const matching =
      !!restamp &&
      restamp.kind === "restamp" &&
      restamp.provider === "mediatool" &&
      restamp.mode === "local" &&
      restamp.subjectType === "file_object" &&
      restamp.subjectId === fileId &&
      restamp.parentType === "production_record" &&
      restamp.parentId === fileId &&
      input.success &&
      input.data.fileId === fileId &&
      input.data.contextHash === contextHash(record) &&
      input.data.ruleVersion === parameters.ruleVersion;
    awaitingRestamp =
      matching &&
      ["queued", "running"].includes(restamp!.state) &&
      restamp!.deadlineAt > deps.clock.now();
    if (matching && restamp?.state === "succeeded" && input.success) {
      const derived = DerivationOutputSchema.safeParse(restamp.output);
      if (derived.success && derived.data.fileId === input.data.destinationFileId) {
        const next = await readProductionWork(deps, tx, derived.data.fileId);
        const task = await tx.mediaJob.findUnique({
          where: {
            dedupeKey: `probe:${next.file.id}:v${parameters.ruleVersion}:${contextHash(record)}`,
          },
        });
        const taskInput = ProbeInputSchema.safeParse(task?.input);
        const result = ProbeOutputSchema.safeParse(task?.output);
        const proof =
          next.production?.source === "restamped" &&
          next.production.derivedFromFileId === fileId &&
          contextHash(next.production) === contextHash(record) &&
          next.file.sha256 === derived.data.sha256 &&
          next.file.sizeBytes === BigInt(derived.data.size) &&
          next.file.status === "stored" &&
          next.file.moderationState !== "block";
        awaitingRestamp =
          proof &&
          !!task &&
          task.kind === "probe" &&
          task.provider === "mediatool" &&
          task.mode === "local" &&
          task.subjectType === "file_object" &&
          task.subjectId === next.file.id &&
          taskInput.success &&
          taskInput.data.fileId === next.file.id &&
          taskInput.data.profile === profileOf(next.file.category) &&
          taskInput.data.ruleVersion === parameters.ruleVersion &&
          taskInput.data.contextHash === contextHash(record) &&
          ((["queued", "running"].includes(task.state) && task.deadlineAt > deps.clock.now()) ||
            (task.state === "succeeded" &&
              result.success &&
              result.data.sourceSha256 === next.file.sha256 &&
              checkProduction(checkFacts(result.data.technical), next.context, parameters).gate ===
                "pass"));
      }
    }
  }
  let playable = null;
  if (ready && record?.kind === "sample") {
    const asset = await tx.playableAsset.findUnique({
      where: {
        kind_sourceFileId_specVersion: {
          kind: "sample",
          sourceFileId: file.id,
          specVersion: parameters.specVersion,
        },
      },
    });
    const parsed = z.array(RenditionSchema).length(1).safeParse(asset?.renditions);
    const watermark = asset?.watermark;
    if (
      asset?.state === "ready" &&
      asset.readyAt &&
      asset.ownerType === "order_item" &&
      asset.ownerId === record.orderItemId &&
      asset.entityId === file.entityId &&
      asset.storeId === file.storeId &&
      watermark &&
      typeof watermark === "object" &&
      !Array.isArray(watermark) &&
      typeof watermark.text === "string" &&
      watermark.text.length > 0 &&
      parsed.success &&
      parsed.data[0]!.fileId !== file.id
    ) {
      const rendition = parsed.data[0]!;
      const [target, task] = await Promise.all([
        tx.fileObject.findUnique({ where: { id: rendition.fileId } }),
        tx.mediaJob.findUnique({
          where: { dedupeKey: `watermark_sample:${asset.id}:v${asset.specVersion}` },
        }),
      ]);
      const input = PlayableInputSchema.safeParse(task?.input),
        result = cloudOutput.safeParse(task?.output);
      const localInput = LocalSamplePlayableInputSchema.safeParse(task?.input),
        cloudInput = CloudPlayableInputSchema.safeParse(task?.input);
      const rendererVerified = localInput.success
        ? deps.production?.mode === "local_sample_watermark" &&
          task?.mode === "local" &&
          task.provider === "mediatool" &&
          task.externalJobId === null &&
          task.subjectType === "file_object" &&
          localInput.data.sourceSha256 === file.sha256 &&
          localInput.data.contextHash === contextHash(record) &&
          localInput.data.ruleVersion === parameters.ruleVersion &&
          localInput.data.specVersion === parameters.specVersion &&
          watermark.recipe === localInput.data.recipe &&
          context?.aiUsed === false &&
          info?.aigcMeta === null &&
          result.success &&
          result.data.aigcOrigin === null &&
          result.data.size === result.data.technical.sizeBytes &&
          result.data.sha256 !== file.sha256 &&
          result.data.etag === target?.etag &&
          target?.objectKey === localInput.data.objectKey &&
          target.bucket === "media" &&
          !!info &&
          localSampleOutputValid(result.data.technical, info, context, parameters)
        : cloudInput.success && task?.mode === "remote";
      if (
        rendererVerified &&
        target?.status === "stored" &&
        target.category === "sample_wm" &&
        target.moderationState !== "block" &&
        target.entityId === file.entityId &&
        target.storeId === file.storeId &&
        task?.state === "succeeded" &&
        task.kind === "watermark_sample" &&
        task.subjectId === fileId &&
        task.parentType === "playable_asset" &&
        task.parentId === asset.id &&
        input.success &&
        input.data.fileId === fileId &&
        input.data.destinationFileId === target.id &&
        input.data.playableAssetId === asset.id &&
        input.data.watermarks.some((mark) => "text" in mark && mark.text === watermark.text) &&
        result.success &&
        result.data.fileId === target.id &&
        result.data.quality === "source" &&
        result.data.sha256 === target.sha256 &&
        BigInt(result.data.size) === target.sizeBytes &&
        result.data.technical.displayWidth === rendition.width &&
        result.data.technical.displayHeight === rendition.height &&
        (!aiUsed || LabelSchema.safeParse(result.data.technical.aigcMeta).success)
      )
        playable = asset;
    }
  }
  // Private consumer facts only. Raw tags and upload declarations never become a merchant DTO.
  return {
    valid,
    ready,
    awaitingRestamp,
    file: {
      id: file.id,
      entityId: file.entityId,
      storeId: file.storeId,
      category: file.category,
      sizeBytes: file.sizeBytes,
    },
    production: record,
    gate: valid ? check!.gate : null,
    durationMs: valid ? info!.durationMs : null,
    playable,
  };
}
