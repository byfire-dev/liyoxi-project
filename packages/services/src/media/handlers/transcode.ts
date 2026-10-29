import { createHash } from "node:crypto";
import type { MediaJob } from "@liyoxi/db";
import type { StorageBucket } from "../../providers/types.js";
import type { BoundMediaDeps } from "../context.js";
import type { MediaJobHandler, JobOutcome, JobJson } from "../jobs/types.js";
import { createRemoteMediaHandler } from "../jobs/remote.js";
import { systemProduceId } from "../jobs/convergence.js";
import { contextHash, createDerivedFile, readProductionWork } from "../production.js";
import { LabelSchema, parseLabel, technicalReport } from "../production-report.js";
import { playableCurrent } from "../production-playables.js";
import { CloudPlayableInputSchema, PlayableOutputSchema } from "../playable-schemas.js";
import { finishPlayable } from "./playable-finish.js";
import { DerivationInputSchema, derivationCurrent, finishDerivation } from "./restamp.js";
import { lockRows } from "../../kernel/index.js";
import { failed } from "../../providers/types.js";
type Kind = "transcode_mp4" | "watermark_sample" | "normalize";
const outputSchema = PlayableOutputSchema;
const failure = (code: string, retryable = false): JobOutcome => ({
  state: "failed",
  failure: { code, retryable },
});
export function createCloudProductionHandler(deps: BoundMediaDeps, kind: Kind): MediaJobHandler {
  const schema = kind === "normalize" ? DerivationInputSchema : CloudPlayableInputSchema;
  const input = (job: MediaJob) => schema.parse(job.input);
  const parsed = (value: unknown) => schema.parse(value);
  const production = deps.production;
  if (production && production.mode !== undefined && production.mode !== "full")
    return {
      kind,
      mode: "remote",
      validInput: (value) => schema.safeParse(value).success,
      validOutput: (value) => outputSchema.safeParse(value).success,
      current: async () => true,
      canRetry: async () => false,
      execute: async () => failure("MEDIA_PROVIDER_UNSUPPORTED"),
      recover: async () => failure("MEDIA_PROVIDER_UNSUPPORTED"),
      poll: async () => failure("MEDIA_PROVIDER_UNSUPPORTED"),
    };
  const cloud = production?.cloud;
  if (!production || !cloud)
    return {
      kind,
      mode: "remote",
      provider: "unconfigured",
      validInput: (value) => schema.safeParse(value).success,
      validOutput: (value) => outputSchema.safeParse(value).success,
      current: async () => true,
      execute: async () => failure("MEDIA_PROVIDER_UNSUPPORTED"),
    };
  const base = createRemoteMediaHandler({
    provider: cloud,
    now: () => deps.clock.now(),
    definition: {
      kind,
      validInput: (value) => schema.safeParse(value).success,
      validOutput: (value) => outputSchema.safeParse(value).success,
      current: async (tx, job) => {
        if (job.subjectType !== "file_object") return false;
        if (kind === "normalize") return derivationCurrent(deps, tx, job);
        const value = CloudPlayableInputSchema.parse(job.input);
        if (
          value.fileId !== job.subjectId ||
          (kind === "transcode_mp4" ? value.quality === "source" : value.quality !== "source")
        )
          return false;
        const asset = await tx.playableAsset.findUnique({ where: { id: value.playableAssetId } });
        const pointer =
          asset?.kind === "trailer"
            ? await deps.production?.readTrailerFacts?.(tx, asset.ownerId)
            : null;
        const refs = await tx.fileRef.findMany({
          where: {
            refType: "playable_asset",
            refId: {
              in: [value.playableAssetId, pointer?.currentPlayableAssetId].filter(
                (id): id is string => !!id,
              ),
            },
            state: "live",
          },
        });
        await lockRows(tx, "file_object", [
          value.fileId,
          value.destinationFileId,
          ...(asset?.coverFileId ? [asset.coverFileId] : []),
          ...refs.map((r) => r.fileId),
        ]);
        return playableCurrent(tx, job);
      },
      finish: async (tx, job, result, ctx) => {
        if (result.state !== "succeeded") return;
        const output = outputSchema.parse(result.output);
        if (kind === "normalize")
          return finishDerivation(
            deps,
            tx,
            job,
            {
              state: "succeeded",
              output: {
                fileId: output.fileId,
                size: output.size,
                sha256: output.sha256,
                etag: output.etag,
                technical: output.technical,
                aigcOrigin: output.aigcOrigin,
              } as unknown as JobJson,
            },
            ctx,
          );
        return finishPlayable(deps, tx, job, result);
      },
    },
    submission: (value) => {
      const one = parsed(value),
        scratchKey = "scratchKey" in one ? one.scratchKey : "";
      // normalize scratch is derived from its fixed destination UUID, never a caller URL.
      const key = scratchKey || `ci-out/${one.destinationFileId}/output.mp4`;
      return {
        tag: "Transcode",
        src: { bucket: "media", key: "" },
        dst: { bucket: "media", key },
        template: one.template,
        ...("watermarks" in one ? { watermarks: one.watermarks } : {}),
      };
    },
  });
  // Source key is a current DB fact, not accepted from the public command body.
  const sourceProvider = {
    ...cloud,
    transcode: async (request: Parameters<typeof cloud.transcode>[0]) => {
      const id = request.userData.split(":")[0]!;
      const { file, job } = await deps.tx.run(async (tx) => {
        const job = await tx.mediaJob.findUniqueOrThrow({ where: { id } });
        return {
          job,
          file: await tx.fileObject.findUniqueOrThrow({ where: { id: job.subjectId } }),
        };
      });
      let watermarks = request.watermarks;
      if (kind === "watermark_sample") {
        const mark = request.watermarks?.[0];
        if (
          !production?.tool.watermarkPng ||
          request.watermarks?.length !== 1 ||
          !mark ||
          !("text" in mark) ||
          !request.signal
        )
          return failed("unsupported", "未配置固定字体图片水印能力");
        const text = mark.text,
          digest = createHash("sha256").update(text).digest("hex"),
          key = `ci-out/${job.id}/watermark-${digest}.png`;
        const rendered = await production.workspace.run(job, request.signal, async (work) => {
          const result = await production.tool.watermarkPng!({
            outPath: work.path("watermark.png"),
            text,
            signal: request.signal,
          });
          if (!result.ok) return result;
          return work.publish({
            name: "watermark.png",
            dst: { bucket: "media", key },
            contentIdentity: digest,
            expectedSha256: result.value.sha256,
            expectedSize: result.value.sizeBytes,
          });
        });
        if (!rendered.ok) return rendered;
        watermarks = [
          { image: { bucket: "media", key }, position: "Center", transparency: mark.transparency },
        ];
      }
      return cloud.transcode({
        ...request,
        watermarks,
        src: { bucket: file.bucket as StorageBucket, key: file.objectKey },
      });
    },
  };
  const native = createRemoteMediaHandler({
    provider: sourceProvider,
    now: () => deps.clock.now(),
    definition: {
      kind,
      validInput: base.validInput,
      validOutput: base.validOutput,
      current: base.current,
      finish: base.finish,
    },
    submission: (value) => {
      const one = parsed(value);
      return {
        tag: "Transcode",
        src: { bucket: "media", key: "" },
        dst: {
          bucket: "media",
          key: "scratchKey" in one ? one.scratchKey : `ci-out/${one.destinationFileId}/output.mp4`,
        },
        template: one.template,
        ...("watermarks" in one ? { watermarks: one.watermarks } : {}),
      };
    },
  });
  // Recovery must use the same actual source key as submission; an empty source is never a completeness proof.
  const find = cloud.find?.bind(cloud);
  sourceProvider.find = find
    ? async (request) => {
        const id = request.userData.split(":")[0]!,
          file = await deps.tx.run(async (tx) => {
            const job = await tx.mediaJob.findUniqueOrThrow({ where: { id } });
            return tx.fileObject.findUniqueOrThrow({ where: { id: job.subjectId } });
          });
        return find({
          ...request,
          src: { bucket: file.bucket as StorageBucket, key: file.objectKey },
        });
      }
    : undefined;
  return {
    ...native,
    poll: async (job, signal) => {
      const remote = await native.poll!(job, signal);
      if (remote.state !== "succeeded") return remote;
      const value = input(job),
        playableInput = kind === "normalize" ? null : CloudPlayableInputSchema.parse(value);
      const facts = await deps.tx.run((tx) => readProductionWork(deps, tx, job.subjectId));
      if (
        kind === "normalize" &&
        contextHash(facts.production) !== DerivationInputSchema.parse(value).contextHash
      )
        return { state: "canceled" };
      const srcInfo = await deps.tx.run((tx) =>
        tx.mediaInfo.findUnique({ where: { fileId: facts.file.id } }),
      );
      let upstream = srcInfo?.aigcMeta ? LabelSchema.safeParse(srcInfo.aigcMeta) : null;
      // A normalization may precede the first technical probe. Read the actual source
      // before choosing seven fields, rather than replacing an unseen upstream label.
      if (kind === "normalize" && !srcInfo) {
        const size = Number(facts.file.sizeBytes);
        if (!Number.isSafeInteger(size) || size <= 0 || !facts.file.etag)
          return failure("MEDIA_FACTS_MISSING");
        const source = await production.workspace.run(job, signal, async (work) => {
          const downloaded = await work.download({
            bucket: facts.file.bucket as StorageBucket,
            key: facts.file.objectKey,
            size,
            etag: facts.file.etag!,
          });
          if (!downloaded.ok) return downloaded;
          return production.tool.probe({
            path: work.path("source.mp4"),
            demuxers: ["mov"],
            signal,
          });
        });
        if (!source.ok)
          return failure("MEDIA_SOURCE_PROBE_FAILED", source.reason === "unavailable");
        const label = parseLabel(source.value.aigc);
        if (source.value.aigc !== null && !label) return failure("MEDIA_AIGC_INVALID");
        upstream = label ? LabelSchema.safeParse(label) : null;
      }
      if (upstream && !upstream.success) return failure("MEDIA_AIGC_INVALID");
      const ai =
        playableInput?.aiUsed ??
        (facts.production?.aiUsage as { used?: boolean } | undefined)?.used === true;
      const label = upstream?.success
        ? upstream.data
        : ai
          ? LabelSchema.parse({
              ...production.config.aigc,
              ProduceID: systemProduceId(value.destinationFileId),
              PropagateID: production.config.aigc.ContentPropagator
                ? systemProduceId(value.destinationFileId)
                : "",
            })
          : null;
      const scratchKey =
        "scratchKey" in value ? value.scratchKey : `ci-out/${value.destinationFileId}/output.mp4`;
      const head = await deps.storage.head({ bucket: "media", key: scratchKey, signal });
      if (
        !head.ok ||
        !head.value.exists ||
        !head.value.etag ||
        !Number.isSafeInteger(head.value.size) ||
        head.value.size <= 0 ||
        head.value.size > 2 * 1024 ** 3
      )
        return failure("MEDIA_REMOTE_OBJECT_MISSING", true);
      return production.workspace.run(job, signal, async (work) => {
        const downloaded = await work.download({
          bucket: "media",
          key: scratchKey,
          size: head.value.size,
          etag: head.value.etag!,
        });
        if (!downloaded.ok)
          return failure("MEDIA_REMOTE_OBJECT_CHANGED", downloaded.reason === "unavailable");
        let name: "source.mp4" | "stamped.mp4" = "source.mp4";
        const first = await production.tool.probe({
          path: work.path(name),
          demuxers: ["mov"],
          signal,
        });
        if (!first.ok) return failure("MEDIA_PROBE_FAILED", first.reason === "unavailable");
        if (first.value.aigc !== null && !parseLabel(first.value.aigc))
          return failure("MEDIA_AIGC_INVALID");
        if (label) {
          const current = parseLabel(first.value.aigc);
          if (
            current &&
            Object.keys(label).some(
              (key) => current[key as keyof typeof current] !== label[key as keyof typeof label],
            )
          )
            return failure("MEDIA_AIGC_READBACK_MISMATCH");
          if (!current) {
            const stamped = await production.tool.stampAigc({
              path: work.path(name),
              outPath: work.path("stamped.mp4"),
              aigcJson: JSON.stringify(label),
              signal,
            });
            if (!stamped.ok)
              return failure("MEDIA_AIGC_STAMP_FAILED", stamped.reason === "unavailable");
            name = "stamped.mp4";
          }
        }
        const readback = await production.tool.probe({
          path: work.path(name),
          demuxers: ["mov"],
          signal,
        });
        if (!readback.ok) return failure("MEDIA_PROBE_FAILED", readback.reason === "unavailable");
        const technical = technicalReport(readback.value),
          actualLabel = parseLabel(readback.value.aigc);
        if (
          !technical ||
          technical.invalidAigc ||
          (label &&
            (!actualLabel ||
              Object.keys(label).some(
                (key) =>
                  actualLabel[key as keyof typeof actualLabel] !== label[key as keyof typeof label],
              )))
        )
          return failure("MEDIA_AIGC_READBACK_MISMATCH");
        const quality = playableInput?.quality ?? "source",
          width = kind === "normalize" ? 1080 : quality === "sd" ? 480 : 720,
          height = kind === "normalize" ? 1920 : quality === "sd" ? 854 : 1280;
        const fps =
          technical.fpsNum && technical.fpsDen ? technical.fpsNum / technical.fpsDen : null;
        if (
          technical.container !== "mp4" ||
          technical.vcodec !== "h264" ||
          !["High", "Main"].includes(technical.vprofile ?? "") ||
          technical.acodec !== "aac" ||
          technical.audioStreamCount !== 1 ||
          !technical.isFaststart ||
          technical.displayWidth !== width ||
          technical.displayHeight !== height ||
          fps === null ||
          fps > 30 ||
          technical.vfr ||
          (kind === "transcode_mp4" &&
            (technical.durationMs === null ||
              technical.durationMs <= 0 ||
              technical.durationMs > 180_000))
        )
          return failure("MEDIA_RENDITION_INVALID");
        const category =
            kind === "transcode_mp4"
              ? "trailer_out"
              : kind === "watermark_sample"
                ? "sample_wm"
                : facts.file.category,
          bucket = kind === "transcode_mp4" ? ("pub" as const) : ("media" as const);
        const stored = await work.publish({
          name,
          dst: { bucket, key: value.objectKey },
          contentIdentity: createHash("sha256")
            .update(JSON.stringify([value.destinationFileId, job.id, kind]))
            .digest("hex"),
        });
        if (!stored.ok || stored.value.size !== technical.sizeBytes)
          return failure("MEDIA_DERIVED_VERIFY_FAILED");
        await deps.tx.run((tx) =>
          createDerivedFile(
            tx,
            { ...facts.file, category, bucket },
            {
              id: value.destinationFileId,
              objectKey: value.objectKey,
              ...stored.value,
              ...(kind === "normalize" &&
              DerivationInputSchema.parse(value).manual &&
              facts.production
                ? { manual: { job, sourceRecord: facts.production } }
                : {}),
            },
            deps.clock.now(),
          ),
        );
        return {
          state: "succeeded",
          output: {
            fileId: value.destinationFileId,
            ...stored.value,
            technical,
            quality,
            aigcOrigin: label ? (upstream?.success ? "upstream" : "stamped") : null,
          } as unknown as JobJson,
        };
      });
    },
  };
}
export const createTranscodeHandler = (deps: BoundMediaDeps) =>
  createCloudProductionHandler(deps, "transcode_mp4");
