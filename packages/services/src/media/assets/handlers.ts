import type { MediaJob, StoreAsset } from "@liyoxi/db";
import type { Tx } from "../../kernel/index.js";
import { uuidv7 } from "../../kernel/index.js";
import { createSigner } from "../read.js";
import { contextHash, readProductionWork } from "../production.js";
import { createProbeHandler, ProbeInputSchema, ProbeOutputSchema } from "../handlers/probe.js";
import type {
  MediaJobHandler,
  MediaConvergenceHandler,
  JobOutcome,
  JobJson,
  MediaJobKind,
} from "../jobs/types.js";
import type { AssetDeps } from "./context.js";
import { assetFiles, lockAssetFiles } from "./repo.js";
import {
  AssetJobInputSchema,
  AssetJobOutputSchema,
  assetJobOwned,
  advanceAsset,
  currentAssetRun,
  insightForKind,
  storeAssetInsight,
} from "./pipeline.js";
import { objectContent } from "./views.js";
import { assetFileSteps } from "./steps.js";
import type { AssetType } from "./steps.js";

const done = (
  status: "ok" | "skipped",
  content: Record<string, JobJson> = {},
  reason: string | null = null,
  verdict: "pass" | "review" | "block" | "pending" | null = null,
): JobOutcome => ({
  state: "succeeded",
  output: { status, reason, content, verdict },
});
const skipped = (reason: string) => done("skipped", {}, reason);
const failed = (code: string): JobOutcome => ({
  state: "failed",
  failure: { code, retryable: false },
});
interface PreparedAsset {
  readonly asset: StoreAsset;
  readonly file: Awaited<ReturnType<typeof assetFiles>>[number]["file"] | null;
  readonly text: string;
  readonly permitted: boolean;
  readonly reused: { id: string; content: JobJson } | null;
  readonly probe?: Awaited<ReturnType<typeof readProductionWork>>;
}

async function current(deps: AssetDeps, tx: Tx, job: MediaJob): Promise<boolean> {
  if (!assetJobOwned(job)) return false;
  const input = AssetJobInputSchema.parse(job.input);
  const asset = await tx.storeAsset.findUnique({ where: { id: input.assetId } });
  if (
    !asset ||
    asset.deletedAt ||
    asset.processingState === "processed" ||
    asset.moderationState === "block"
  )
    return false;
  if (
    job.kind !== "digest" &&
    !assetFileSteps(
      asset.type as AssetType,
      asset.uploadActorType === "merchant" && asset.uploadClient === "weapp",
    ).includes(job.kind as MediaJobKind)
  )
    return false;
  const run = await currentAssetRun(tx, asset.id);
  if (!run || run.runId !== input.runId || run.promptVersion !== input.promptVersion) return false;
  const links = await assetFiles(tx, asset.id);
  await lockAssetFiles(tx, [
    ...links.flatMap(({ file }) => [
      file.id,
      ...(file.mediaInfo?.coverFileId ? [file.mediaInfo.coverFileId] : []),
    ]),
    input.coverFileId,
  ]);
  if (!input.fileId)
    return (
      (job.kind === "digest" || asset.type === "text") &&
      input.etag === null &&
      input.crc64 === null &&
      input.sizeBytes === null
    );
  const file = links.find((link) => link.fileId === input.fileId)?.file;
  return (
    !!file &&
    file.entityId === asset.entityId &&
    file.storeId === asset.storeId &&
    file.category === "store_asset" &&
    file.status === "stored" &&
    file.moderationState !== "block" &&
    file.etag === input.etag &&
    file.crc64 === input.crc64 &&
    file.sizeBytes?.toString() === input.sizeBytes
  );
}
async function prepare(deps: AssetDeps, tx: Tx, job: MediaJob): Promise<PreparedAsset> {
  const input = AssetJobInputSchema.parse(job.input);
  const asset = await tx.storeAsset.findUniqueOrThrow({ where: { id: input.assetId } });
  const file = input.fileId
    ? ((await assetFiles(tx, asset.id)).find((link) => link.fileId === input.fileId)?.file ?? null)
    : null;
  const insights = await tx.storeAssetInsight.findMany({
    where: {
      storeAssetId: asset.id,
      promptVersion: input.promptVersion,
      status: "ok",
      ...(input.fileId ? { fileId: input.fileId } : {}),
    },
    orderBy: { id: "asc" },
  });
  const text = [
    asset.textBody,
    ...insights.map((row) => {
      const value = objectContent(row.content);
      return typeof value.text === "string"
        ? value.text
        : typeof value.description === "string"
          ? value.description
          : "";
    }),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 10000);
  const kind = insightForKind[job.kind as MediaJobKind];
  const reusable =
    file?.crc64 && file.sizeBytes !== null && kind && job.kind !== "probe"
      ? await tx.storeAssetInsight.findFirst({
          where: {
            kind,
            promptVersion: input.promptVersion,
            status: "ok",
            storeAssetId: { not: asset.id },
            storeAsset: {
              entityId: asset.entityId,
              deletedAt: null,
              moderationState: { not: "block" },
            },
            file: {
              crc64: file.crc64,
              sizeBytes: file.sizeBytes,
              entityId: asset.entityId,
              status: "stored",
              moderationState: { not: "block" },
            },
          },
          orderBy: { id: "asc" },
        })
      : null;
  const model = ["asr", "vision", "digest"].includes(job.kind);
  return {
    asset,
    file,
    text,
    permitted:
      !model ||
      !!(await deps.assets.allowModelCall?.(tx, { storeId: asset.storeId, now: deps.clock.now() })),
    reused: reusable ? { id: reusable.id, content: reusable.content as JobJson } : null,
    ...(job.kind === "probe" && file && deps.production
      ? { probe: await readProductionWork(deps, tx, file.id) }
      : {}),
  };
}

/** Observe the original file audit. Never submit a second WX/CI request or replace its trace. */
async function originalAudit(deps: AssetDeps, job: MediaJob): Promise<JobOutcome> {
  const input = AssetJobInputSchema.parse(job.input);
  return deps.tx.run(async (tx) => {
    const file = input.fileId
      ? await tx.fileObject.findUnique({ where: { id: input.fileId } })
      : null;
    if (!file || file.status !== "stored") return skipped("audit_source_missing");
    if (["pass", "review", "block"].includes(file.moderationState))
      return done("ok", {}, null, file.moderationState as "pass" | "review" | "block");
    const existing = await tx.mediaJob.findFirst({
      where: {
        subjectType: "file_object",
        subjectId: file.id,
        parentId: null,
        kind: {
          in: job.kind === "audit_image_wx" ? ["audit_image_wx", "audit_image"] : [job.kind],
        },
        state: { in: ["queued", "running", "submitting", "submitted"] },
        deadlineAt: { gt: deps.clock.now() },
      },
      orderBy: { id: "desc" },
    });
    return existing
      ? { state: "submitted", externalJobId: existing.id }
      : done("skipped", {}, "audit_unavailable", "pending");
  });
}
function adaptedProbe(job: MediaJob, facts: NonNullable<PreparedAsset["probe"]>): MediaJob {
  const input = AssetJobInputSchema.parse(job.input);
  return {
    ...job,
    input: ProbeInputSchema.parse({
      fileId: input.fileId,
      profile: "asset",
      ruleVersion: facts.parameters.ruleVersion,
      contextHash: contextHash(null),
      coverFileId: input.coverFileId,
    }),
  };
}

export function createAssetHandlers(deps: AssetDeps): readonly MediaJobHandler[] {
  const signer = createSigner(deps),
    probe = createProbeHandler(deps);
  const kinds = [
    "probe",
    "audit_image",
    "audit_image_wx",
    "audit_video",
    "audit_text",
    "asr",
    "vision",
    "doc_extract",
    "digest",
  ] as const;
  return kinds.map((kind): MediaJobHandler => ({
    kind,
    mode: ["audit_image_wx", "audit_video", "asr"].includes(kind) ? "remote" : "local",
    provider:
      kind === "probe" || kind === "doc_extract"
        ? "mediatool"
        : kind === "audit_image_wx"
          ? "wechat"
          : kind === "asr"
            ? deps.assets.asr.status
            : kind === "vision" || kind === "digest"
              ? deps.assets.llm.status
              : (deps.moderation?.status ?? "unconfigured"),
    claims: assetJobOwned,
    validInput: (input) => AssetJobInputSchema.safeParse(input).success,
    validOutput: (output) => AssetJobOutputSchema.safeParse(output).success,
    current: (tx, job) => current(deps, tx, job),
    prepare: (tx, job) => prepare(deps, tx, job),
    execute: async (job, context, signal): Promise<JobOutcome> => {
      const prepared = context as PreparedAsset;
      if (signal.aborted) return failed("ASSET_CANCELED");
      if (prepared.reused)
        return {
          state: "succeeded",
          output: {
            status: "ok",
            reason: null,
            content: prepared.reused.content,
            verdict: null,
            reusedFromId: prepared.reused.id,
          },
        };
      if (kind === "probe") {
        if (!prepared.probe) return skipped("mediatool_unconfigured");
        const result = await probe.execute(
          adaptedProbe(job, prepared.probe),
          prepared.probe,
          signal,
        );
        if (result.state !== "succeeded") return result;
        const output = ProbeOutputSchema.parse(result.output);
        return {
          state: "succeeded",
          output: {
            status: "ok",
            reason: null,
            verdict: null,
            probe: result.output,
            content: {
              label: [
                output.technical.displayWidth && output.technical.displayHeight
                  ? `${output.technical.displayWidth}×${output.technical.displayHeight}`
                  : null,
                output.technical.durationMs !== null
                  ? `${Math.ceil(output.technical.durationMs / 1000)}s`
                  : null,
              ]
                .filter(Boolean)
                .join(" · "),
            },
          },
        };
      }
      if (["audit_image", "audit_image_wx", "audit_video"].includes(kind))
        return originalAudit(deps, job);
      if (kind === "audit_text") {
        if (!prepared.text) return done("skipped", {}, "text_missing", "pending");
        if (!deps.moderation || deps.moderation.status === "unconfigured")
          return done("skipped", {}, "audit_unconfigured", "pending");
        const result = await deps.moderation.auditText({
          bucket: "asset",
          text: prepared.text,
          userData: `${job.id}:${job.attemptNo}`,
          signal,
        });
        return result.ok && result.value.processed
          ? done("ok", {}, null, result.value.verdict)
          : done("skipped", {}, "audit_unavailable", "pending");
      }
      if (kind === "doc_extract") {
        const file = prepared.file;
        if (!file || !file.etag || file.sizeBytes === null) return skipped("document_missing");
        // No reviewed office/PDF extractor is currently exposed to this domain.
        if (file.ext !== "txt") return skipped("document_extractor_unconfigured");
        if (file.sizeBytes > 40000n) return skipped("document_text_limit");
        const chunks: Uint8Array[] = [];
        const read = await deps.storage.readTo({
          bucket: "asset",
          key: file.objectKey,
          expectedSize: Number(file.sizeBytes),
          maxBytes: 40000,
          ifMatchEtag: file.etag,
          signal,
          sink: async (chunk) => {
            chunks.push(chunk.slice());
          },
        });
        if (!read.ok) return skipped("document_read_unavailable");
        const bytes = Buffer.concat(chunks);
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          try {
            text = new TextDecoder("gbk", { fatal: true }).decode(bytes);
          } catch {
            return skipped("document_encoding_invalid");
          }
        }
        return done("ok", { text: [...text].slice(0, 10000).join(""), pageCount: 1 });
      }
      if (!prepared.permitted) return skipped("budget_unconfigured");
      if (kind === "asr") {
        if (deps.assets.asr.status === "unconfigured" || !prepared.file)
          return skipped("asr_unconfigured");
        const signed = await signer({ fileId: prepared.file.id, audience: "staff" });
        const result = await deps.assets.asr.transcribe({ url: signed.signed.url });
        return result.ok
          ? done("ok", { text: result.value.text, segments: [] })
          : skipped("asr_unavailable");
      }
      if (deps.assets.llm.status === "unconfigured") return skipped("llm_unconfigured");
      if (kind === "vision") {
        if (!prepared.file) return skipped("vision_source_missing");
        const signed = await signer({ fileId: prepared.file.id, audience: "staff" });
        const result = await deps.assets.llm.tagAsset({
          kind: prepared.asset.type === "image" ? "image" : "video",
          url: signed.signed.url,
        });
        return result.ok
          ? done("ok", { description: result.value.description, tags: result.value.tags })
          : skipped("vision_unavailable");
      }
      if (!prepared.text) return skipped("digest_source_missing");
      const result = await deps.assets.llm.extractKeyPoints({ text: prepared.text, maxPoints: 6 });
      return result.ok
        ? done("ok", { keypoints: result.value.points })
        : skipped("digest_unavailable");
    },
    poll: (job) => originalAudit(deps, job),
    recover: (job) =>
      ["audit_image_wx", "audit_video"].includes(kind)
        ? originalAudit(deps, job)
        : Promise.resolve(skipped("result_unavailable")),
    finish: async (tx, job, outcome, ctx) => {
      const input = AssetJobInputSchema.parse(job.input),
        asset = await tx.storeAsset.findUniqueOrThrow({ where: { id: input.assetId } });
      if (!(await current(deps, tx, job))) return;
      if (outcome.state === "succeeded") {
        const output = AssetJobOutputSchema.parse(outcome.output);
        if (kind === "probe" && output.probe !== undefined) {
          const facts = await readProductionWork(deps, tx, job.subjectId);
          await probe.finish?.(
            tx,
            adaptedProbe(job, facts),
            { state: "succeeded", output: output.probe as JobJson },
            ctx,
          );
        }
        const content =
          output.status === "skipped" && output.reason
            ? { ...output.content, reason: output.reason }
            : output.content;
        await storeAssetInsight(tx, job, asset, output.status, content, output.reusedFromId);
        if (kind === "digest" && asset.type === "document") {
          if (!job.finishedAt) throw new TypeError("素材任务缺少实际完成时间");
          // W315 owns structured JSON extraction; record the missing capability instead of
          // presenting an absent result as an empty successful menu.
          for (const file of await assetFiles(tx, asset.id)) {
            const before = await tx.storeAssetInsight.findFirst({
              where: {
                storeAssetId: asset.id,
                fileId: file.fileId,
                kind: "structured_items",
                promptVersion: input.promptVersion,
              },
            });
            const data = {
              status: "skipped",
              content: { reason: "structured_extractor_unconfigured" },
              provider: job.provider,
              mediaJobId: job.id,
              updatedAt: job.finishedAt,
            };
            if (before) await tx.storeAssetInsight.update({ where: { id: before.id }, data });
            else
              await tx.storeAssetInsight.create({
                data: {
                  ...data,
                  id: uuidv7(),
                  storeAssetId: asset.id,
                  fileId: file.fileId,
                  kind: "structured_items",
                  promptVersion: input.promptVersion,
                  createdAt: job.finishedAt,
                },
              });
          }
          await tx.storeAsset.update({ where: { id: asset.id }, data: { isInsightPartial: true } });
        }
        if (output.status !== "ok")
          await tx.storeAsset.update({ where: { id: asset.id }, data: { isInsightPartial: true } });
        if (output.verdict) {
          const audits = await tx.mediaJob.findMany({
            where: {
              parentType: "store_asset",
              parentId: asset.id,
              kind: { in: ["audit_image", "audit_image_wx", "audit_video", "audit_text"] },
            },
          });
          const verdicts = audits
            .filter((row) => AssetJobInputSchema.safeParse(row.input).data?.runId === input.runId)
            .map((row) => AssetJobOutputSchema.safeParse(row.output).data?.verdict ?? "pending");
          const expected = asset.type === "text" ? 1 : (await assetFiles(tx, asset.id)).length;
          const moderationState = verdicts.includes("block")
            ? "block"
            : verdicts.includes("review")
              ? "review"
              : verdicts.length === expected && verdicts.every((value) => value === "pass")
                ? "pass"
                : "pending";
          await tx.storeAsset.update({ where: { id: asset.id }, data: { moderationState } });
        }
      } else if (outcome.state === "failed" || outcome.state === "canceled") {
        await storeAssetInsight(tx, job, asset, "failed", {
          reason: outcome.state === "failed" ? outcome.failure.code : "canceled",
        });
        await tx.storeAsset.update({ where: { id: asset.id }, data: { isInsightPartial: true } });
      }
    },
  }));
}

/** Dispatch solely by the actual parent. Malformed asset input can never borrow a file handler. */
export function combineAssetHandler(
  original: MediaJobHandler,
  asset: MediaJobHandler,
): MediaJobHandler {
  const select = (job: MediaJob) => (job.parentType === "store_asset" ? asset : original);
  return {
    ...original,
    claims: (job) => select(job).claims?.(job) ?? true,
    validInput: (input) => original.validInput(input) || asset.validInput(input),
    validOutput: (output) => original.validOutput(output) || asset.validOutput(output),
    current: (tx, job) =>
      select(job).validInput(job.input) ? select(job).current(tx, job) : Promise.resolve(false),
    prepare: (tx, job) => select(job).prepare?.(tx, job) ?? Promise.resolve(undefined),
    execute: (job, context, signal) => select(job).execute(job, context, signal),
    poll: (job, signal) =>
      select(job).poll?.(job, signal) ??
      Promise.resolve({
        state: "failed",
        failure: { code: "MEDIA_QUERY_UNSUPPORTED", retryable: false },
      }),
    recover: (job, signal) =>
      select(job).recover?.(job, signal) ??
      Promise.resolve({
        state: "failed",
        failure: { code: "MEDIA_RECOVERY_UNSUPPORTED", retryable: false },
      }),
    cancel: async (job, signal) => {
      await select(job).cancel?.(job, signal);
    },
    finish: async (tx, job, outcome, ctx) => select(job).finish?.(tx, job, outcome, ctx),
    canRetry: (tx, job) => (select(job).canRetry ?? select(job).current)(tx, job),
    retry: async (tx, job) => {
      await select(job).retry?.(tx, job);
    },
  };
}
export function createAssetConvergence(deps: AssetDeps): MediaConvergenceHandler {
  return {
    parentType: "store_asset",
    needed: async (tx, job) => {
      if (!assetJobOwned(job)) return false;
      const asset = await tx.storeAsset.findUnique({ where: { id: job.parentId! } });
      return (
        !!asset &&
        !asset.deletedAt &&
        asset.processingState !== "processed" &&
        asset.moderationState !== "block"
      );
    },
    converge: (tx, id) => advanceAsset(tx, deps, id),
  };
}
