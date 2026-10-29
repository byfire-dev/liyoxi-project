import { createHash } from "node:crypto";
import type { MediaJob } from "@liyoxi/db";
import { AppError, lockRows } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { StorageBucket } from "../../providers/types.js";
import type { BoundMediaDeps } from "../context.js";
import type { JobJson, JobOutcome, MediaJobHandler } from "../jobs/types.js";
import {
  LocalSamplePlayableInputSchema,
  LocalSamplePlayableOutputSchema,
  localSampleOutputValid,
} from "../playable-schemas.js";
import { playableCurrent } from "../production-playables.js";
import { contextHash, createDerivedFile, readProductionWork } from "../production.js";
import { deliveryProductionFacts } from "../production/facts.js";
import { technicalReport } from "../production-report.js";
import { finishPlayable } from "./playable-finish.js";

const failure = (code: string, retryable = false): JobOutcome => ({
  state: "failed",
  failure: { code, retryable },
});
async function localCurrent(deps: BoundMediaDeps, tx: Tx, job: MediaJob, allowLocalFailed = false) {
  if (deps.production?.mode !== "local_sample_watermark" || !deps.production.tool.watermarkSample)
    return false;
  const input = LocalSamplePlayableInputSchema.safeParse(job.input);
  if (
    !input.success ||
    job.subjectType !== "file_object" ||
    job.subjectId !== input.data.fileId ||
    !(await playableCurrent(tx, job, { allowLocalFailed }))
  )
    return false;
  const asset = await tx.playableAsset.findUniqueOrThrow({
    where: { id: input.data.playableAssetId },
  });
  const refs = await tx.fileRef.findMany({
    where: { refType: "playable_asset", refId: asset.id, state: "live" },
  });
  await lockRows(tx, "file_object", [
    input.data.fileId,
    input.data.destinationFileId,
    ...(asset.coverFileId ? [asset.coverFileId] : []),
    ...refs.map((ref) => ref.fileId),
  ]);
  const facts = await readProductionWork(deps, tx, job.subjectId),
    actual = await deliveryProductionFacts(deps, tx, job.subjectId),
    info = await tx.mediaInfo.findUnique({ where: { fileId: job.subjectId } });
  return (
    actual.ready &&
    facts.production?.kind === "sample" &&
    facts.context?.aiUsed === false &&
    (facts.production.aiUsage as { used?: boolean }).used === false &&
    facts.production.aigcState === "not_required" &&
    info?.aigcMeta === null &&
    facts.file.sha256 === input.data.sourceSha256 &&
    facts.parameters.ruleVersion === input.data.ruleVersion &&
    facts.parameters.specVersion === input.data.specVersion &&
    contextHash(facts.production) === input.data.contextHash &&
    asset.ownerType === "order_item" &&
    asset.ownerId === facts.production.orderItemId &&
    asset.entityId === facts.file.entityId &&
    asset.storeId === facts.file.storeId
  );
}
async function prepare(deps: BoundMediaDeps, tx: Tx, job: MediaJob) {
  return {
    facts: await readProductionWork(deps, tx, job.subjectId),
    info: await tx.mediaInfo.findUniqueOrThrow({ where: { fileId: job.subjectId } }),
  };
}
type Work = Awaited<ReturnType<typeof prepare>>;

export function createLocalWatermarkHandler(deps: BoundMediaDeps): MediaJobHandler {
  return {
    kind: "watermark_sample",
    mode: "local",
    provider: "mediatool",
    validInput: (input) => LocalSamplePlayableInputSchema.safeParse(input).success,
    validOutput: (output) => LocalSamplePlayableOutputSchema.safeParse(output).success,
    current: (tx, job) => localCurrent(deps, tx, job),
    canRetry: (tx, job) => localCurrent(deps, tx, job, true),
    retry: async (tx, job) => {
      if (!(await localCurrent(deps, tx, job, true))) throw new AppError("MEDIA_JOB_NOT_RETRYABLE");
      await tx.playableAsset.update({
        where: { id: job.parentId! },
        data: { state: "processing", error: null, readyAt: null, updatedAt: deps.clock.now() },
      });
    },
    prepare: (tx, job) => prepare(deps, tx, job),
    execute: async (job, context, signal) => {
      const production = deps.production;
      if (production?.mode !== "local_sample_watermark" || !production.tool.watermarkSample)
        return failure("MEDIA_PROVIDER_UNSUPPORTED");
      const input = LocalSamplePlayableInputSchema.parse(job.input),
        { facts, info } = context as Work,
        size = Number(facts.file.sizeBytes);
      if (
        facts.context?.aiUsed !== false ||
        (facts.production?.aiUsage as { used?: boolean } | undefined)?.used !== false ||
        info.aigcMeta !== null
      )
        return failure("MEDIA_LOCAL_AIGC_UNSUPPORTED");
      if (
        job.mode !== "local" ||
        job.provider !== "mediatool" ||
        job.externalJobId !== null ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        !facts.file.etag ||
        facts.file.sha256 !== input.sourceSha256 ||
        contextHash(facts.production) !== input.contextHash
      )
        return failure("MEDIA_SOURCE_CHANGED");
      return production.workspace.run(job, signal, async (work) => {
        if (signal.aborted) return failure("MEDIA_JOB_TIMEOUT", true);
        const downloaded = await work.download({
          bucket: facts.file.bucket as StorageBucket,
          key: facts.file.objectKey,
          size,
          etag: facts.file.etag!,
        });
        if (!downloaded.ok)
          return failure("MEDIA_SOURCE_CHANGED", downloaded.reason === "unavailable");
        if (downloaded.value.sha256 !== input.sourceSha256 || downloaded.value.size !== size)
          return failure("MEDIA_SOURCE_CHANGED");
        const rendered = await production.tool.watermarkSample!({
          path: work.path("source.mp4"),
          outPath: work.path("stamped.mp4"),
          text: input.watermarks[0].text,
          timeoutMs: 90_000,
          signal,
        });
        if (!rendered.ok)
          return failure("MEDIA_WATERMARK_FAILED", rendered.reason === "unavailable");
        if (signal.aborted) return failure("MEDIA_JOB_TIMEOUT", true);
        if (
          rendered.value.inputSizeBytes !== size ||
          !/^[a-f0-9]{64}$/.test(rendered.value.sha256) ||
          rendered.value.sha256 === input.sourceSha256
        )
          return failure("MEDIA_RENDITION_INVALID");
        const readback = await production.tool.probe({
          path: work.path("stamped.mp4"),
          demuxers: ["mov"],
          signal,
        });
        if (!readback.ok) return failure("MEDIA_PROBE_FAILED", readback.reason === "unavailable");
        const technical = technicalReport(readback.value);
        if (
          !technical ||
          technical.sizeBytes !== rendered.value.outputSizeBytes ||
          !localSampleOutputValid(technical, info, facts.context, facts.parameters)
        )
          return failure("MEDIA_RENDITION_INVALID");
        if (signal.aborted) return failure("MEDIA_JOB_TIMEOUT", true);
        const stored = await work.publish({
          name: "stamped.mp4",
          dst: { bucket: "media", key: input.objectKey },
          contentIdentity: createHash("sha256")
            .update(
              JSON.stringify([
                input.destinationFileId,
                job.id,
                input.sourceSha256,
                input.contextHash,
                input.recipe,
                input.watermarks,
              ]),
            )
            .digest("hex"),
          expectedSha256: rendered.value.sha256,
          expectedSize: technical.sizeBytes,
        });
        if (
          !stored.ok ||
          stored.value.sha256 !== rendered.value.sha256 ||
          stored.value.size !== technical.sizeBytes
        )
          return failure(
            "MEDIA_DERIVED_VERIFY_FAILED",
            !stored.ok && stored.reason === "unavailable",
          );
        if (signal.aborted) return failure("MEDIA_JOB_TIMEOUT", true);
        await deps.tx.run((tx) =>
          createDerivedFile(
            tx,
            { ...facts.file, category: "sample_wm", bucket: "media" },
            { id: input.destinationFileId, objectKey: input.objectKey, ...stored.value },
            deps.clock.now(),
          ),
        );
        return {
          state: "succeeded",
          output: {
            fileId: input.destinationFileId,
            ...stored.value,
            quality: "source",
            technical,
            aigcOrigin: null,
          } as unknown as JobJson,
        };
      });
    },
    finish: async (tx, job, outcome) => {
      if (outcome.state !== "succeeded") return;
      if (!(await localCurrent(deps, tx, job))) throw new AppError("STATE_NOT_ALLOWED");
      const output = LocalSamplePlayableOutputSchema.parse(outcome.output),
        current = await prepare(deps, tx, job);
      if (
        output.size !== output.technical.sizeBytes ||
        output.sha256 === current.facts.file.sha256 ||
        !localSampleOutputValid(
          output.technical,
          current.info,
          current.facts.context,
          current.facts.parameters,
        )
      )
        throw new AppError("STATE_NOT_ALLOWED");
      return finishPlayable(deps, tx, job, outcome);
    },
  };
}
