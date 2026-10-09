import { z } from "zod";
import { checkProduction } from "@liyoxi/shared";
import { createHash } from "node:crypto";
import type { MediaJob } from "@liyoxi/db";
import type { BoundMediaDeps } from "../context.js";
import type { MediaJobHandler, JobOutcome, JobJson } from "../jobs/types.js";
import {
  contextHash,
  createDerivedFile,
  enqueueDerivation,
  json,
  profileOf,
  readProductionWork,
  requiredJson,
} from "../production.js";
import { TechnicalSchema, checkFacts, technicalReport } from "../production-report.js";
import type { Technical } from "../production-report.js";
import type { Tx, IdentityContext } from "../../kernel/index.js";
import { AppError, lockRows } from "../../kernel/index.js";
import type { StorageBucket } from "../../providers/types.js";
import { link, release } from "../refs.js";
import { enqueueSampleWatermark } from "../production-playables.js";
const inputSchema = z.strictObject({
  fileId: z.uuid(),
  profile: z.enum(["master", "trailer_src", "ad", "sample", "final", "asset"]),
  ruleVersion: z.number().int().min(1).max(32767),
  contextHash: z.string().regex(/^[a-f0-9]{64}$/),
  coverFileId: z.uuid(),
});
const artifact = z.strictObject({
  id: z.uuid(),
  key: z.string().max(512),
  size: z
    .number()
    .int()
    .positive()
    .max(1024 ** 2),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  etag: z.string().min(1).max(256),
});
const resultSchema = z.strictObject({ technical: TechnicalSchema, cover: artifact.nullable() });
const failure = (code: string, retryable = false): JobOutcome => ({
  state: "failed",
  failure: { code, retryable },
});
export async function probeCurrent(deps: BoundMediaDeps, tx: Tx, job: MediaJob): Promise<boolean> {
  const parsed = inputSchema.safeParse(job.input);
  if (!parsed.success || job.subjectType !== "file_object" || parsed.data.fileId !== job.subjectId)
    return false;
  const old = await tx.mediaInfo.findUnique({
    where: { fileId: job.subjectId },
    select: { coverFileId: true },
  });
  const source = await tx.productionRecord.findUnique({
    where: { fileId: job.subjectId },
    select: { derivedFromFileId: true },
  });
  await lockRows(tx, "file_object", [
    job.subjectId,
    parsed.data.coverFileId,
    ...(old?.coverFileId ? [old.coverFileId] : []),
    ...(source?.derivedFromFileId ? [source.derivedFromFileId] : []),
  ]);
  const facts = await readProductionWork(deps, tx, job.subjectId);
  if (
    facts.production?.derivedFromFileId &&
    facts.production.derivedFromFileId !== source?.derivedFromFileId
  )
    throw new AppError("BUSY");
  return (
    facts.file.status === "stored" &&
    facts.file.moderationState !== "block" &&
    facts.parameters.ruleVersion === parsed.data.ruleVersion &&
    parsed.data.profile === profileOf(facts.file.category) &&
    job.dedupeKey ===
      `probe:${job.subjectId}:v${parsed.data.ruleVersion}:${parsed.data.contextHash}` &&
    contextHash(facts.production) === parsed.data.contextHash
  );
}
export async function saveTechnical(
  tx: Tx,
  fileId: string,
  info: Technical,
  coverFileId: string | null,
  now: Date,
) {
  const {
    bitDepth: _depth,
    sizeBytes: _size,
    invalidAigc: _invalid,
    vfr: _vfr,
    aigcMeta,
    raw,
    ...columns
  } = info;
  const data = {
    ...columns,
    aigcMeta: json(aigcMeta),
    raw: requiredJson(raw),
    coverFileId,
    probeVersion: 1,
    probedAt: now,
    updatedAt: now,
  };
  await tx.mediaInfo.upsert({
    where: { fileId },
    create: { fileId, ...data, createdAt: now },
    update: data,
  });
}
export async function emitChecked(
  deps: BoundMediaDeps,
  tx: Tx,
  ctx: IdentityContext,
  facts: Awaited<ReturnType<typeof readProductionWork>>,
  gate: "pass" | "reject",
  durationMs: number | null,
) {
  if (!facts.production) return;
  const kind = facts.production.kind as "sample" | "final" | "ad";
  await deps.events.emit(tx, ctx, {
    type: "media.production.checked",
    aggregate: { type: "production_record", id: facts.file.id },
    entityId: facts.file.entityId,
    storeId: facts.file.storeId,
    payload: {
      v: 1,
      fileId: facts.file.id,
      kind,
      gate,
      ...(facts.production.orderItemId ? { orderItemId: facts.production.orderItemId } : {}),
      ...(durationMs !== null ? { durationMs } : {}),
    },
    dedupeKey: `${facts.file.id}:v${facts.parameters.ruleVersion}:${contextHash(facts.production)}`,
  });
}
function ordinaryChecks(info: Technical, profile: string, adKind: "head" | "tail" | null) {
  const vertical =
    info.displayWidth !== null &&
    info.displayHeight !== null &&
    info.displayWidth >= 720 &&
    info.displayHeight >= 1280 &&
    Math.abs(info.displayWidth / info.displayHeight / (9 / 16) - 1) <= 0.01;
  const audio = info.audioStreamCount >= 1,
    duration = info.durationMs;
  const pass =
    profile === "asset" ||
    (vertical &&
      audio &&
      duration !== null &&
      (profile === "master"
        ? duration >= 20_000 && duration < 1_200_000 && info.sizeBytes <= 500 * 1024 ** 2
        : profile === "trailer_src"
          ? duration > 0 && duration <= 180_000
          : info.displayWidth === 1080 &&
            info.displayHeight === 1920 &&
            info.vcodec === "h264" &&
            info.acodec === "aac" &&
            (adKind === "head"
              ? duration >= 2500 && duration <= 5500
              : adKind === "tail"
                ? duration >= 4500 && duration <= 10500
                : false)));
  return {
    gate: pass ? ("pass" as const) : ("reject" as const),
    hard: [{ code: "profile", pass, actual: profile, expected: "D5.6.1" }],
    soft: [],
  };
}
export function createProbeHandler(deps: BoundMediaDeps): MediaJobHandler {
  return {
    kind: "probe",
    mode: "local",
    provider: "mediatool",
    validInput: (input) => inputSchema.safeParse(input).success,
    validOutput: (output) => resultSchema.safeParse(output).success,
    current: (tx, job) => probeCurrent(deps, tx, job),
    prepare: (tx, job) => readProductionWork(deps, tx, job.subjectId),
    execute: async (job, context, signal) => {
      const production = deps.production;
      if (!production) return failure("MEDIA_PROVIDER_UNSUPPORTED");
      const facts = context as Awaited<ReturnType<typeof readProductionWork>>,
        input = inputSchema.parse(job.input);
      const size = Number(facts.file.sizeBytes);
      if (!Number.isSafeInteger(size) || size <= 0 || !facts.file.etag)
        return failure("MEDIA_FACTS_MISSING");
      return production.workspace.run(job, signal, async (work) => {
        const downloaded = await work.download({
          bucket: facts.file.bucket as StorageBucket,
          key: facts.file.objectKey,
          size,
          etag: facts.file.etag!,
        });
        if (!downloaded.ok)
          return failure("MEDIA_SOURCE_CHANGED", downloaded.reason === "unavailable");
        const probed = await production.tool.probe({
          path: work.path("source.mp4"),
          demuxers: ["mov", "mp3", "wav", "aac"],
          signal,
        });
        if (!probed.ok) return failure("MEDIA_PROBE_FAILED", probed.reason === "unavailable");
        const technical = technicalReport(probed.value);
        if (!technical || technical.sizeBytes !== size) return failure("MEDIA_REPORT_INVALID");
        let cover: z.infer<typeof artifact> | null = null;
        if (technical.kind === "video") {
          const poster = await production.tool.poster({
            path: work.path("source.mp4"),
            demuxer: probed.value.demuxer,
            atMs: (technical.durationMs ?? 0) > 1000 ? 1000 : 0,
            outPath: work.path("poster.jpg"),
            signal,
          });
          if (!poster.ok) return failure("MEDIA_POSTER_FAILED", poster.reason === "unavailable");
          const key = `covers/${input.coverFileId}.jpg`,
            stored = await work.publish({
              name: "poster.jpg",
              dst: { bucket: "asset", key },
              expectedSha256: createHash("sha256").update(poster.value.bytes).digest("hex"),
              expectedSize: poster.value.sizeBytes,
              contentIdentity: createHash("sha256")
                .update(JSON.stringify([job.id, job.subjectId, "cover"]))
                .digest("hex"),
            });
          if (!stored.ok || stored.value.size !== poster.value.sizeBytes)
            return failure("MEDIA_POSTER_VERIFY_FAILED");
          cover = { id: input.coverFileId, key, ...stored.value };
          await deps.tx.run((tx) =>
            createDerivedFile(
              tx,
              { ...facts.file, bucket: "asset", category: "video_cover" },
              {
                id: input.coverFileId,
                objectKey: key,
                ...stored.value,
                mime: "image/jpeg",
                ext: "jpg",
              },
              deps.clock.now(),
            ),
          );
        }
        return { state: "succeeded", output: { technical, cover } as unknown as JobJson };
      });
    },
    finish: async (tx, job, outcome, ctx) => {
      if (outcome.state !== "succeeded") return;
      const output = resultSchema.parse(outcome.output),
        input = inputSchema.parse(job.input),
        facts = await readProductionWork(deps, tx, job.subjectId),
        now = deps.clock.now();
      if (
        output.cover &&
        (output.cover.id !== input.coverFileId ||
          output.cover.key !== `covers/${input.coverFileId}.jpg`)
      )
        throw new Error("媒体封面归属不一致");
      if (output.cover)
        await createDerivedFile(
          tx,
          { ...facts.file, bucket: "asset", category: "video_cover" },
          { ...output.cover, objectKey: output.cover.key, mime: "image/jpeg", ext: "jpg" },
          now,
        );
      const previous = await tx.mediaInfo.findUnique({
        where: { fileId: facts.file.id },
        select: { coverFileId: true },
      });
      await saveTechnical(tx, facts.file.id, output.technical, output.cover?.id ?? null, now);
      if (previous?.coverFileId && previous.coverFileId !== output.cover?.id)
        await release(deps, tx, {
          fileId: previous.coverFileId,
          entityId: facts.file.entityId,
          storeId: facts.file.storeId,
          refType: "media_info",
          refId: facts.file.id,
          role: "cover",
          keepUntil: new Date(now.getTime() + 30 * 86_400_000),
        });
      if (output.cover)
        await link(deps, tx, {
          fileId: output.cover.id,
          entityId: facts.file.entityId,
          storeId: facts.file.storeId,
          refType: "media_info",
          refId: facts.file.id,
          role: "cover",
        });
      const adKind = facts.production?.adId
        ? ((await deps.production?.readAdKind?.(tx, facts.production.adId)) ?? null)
        : null;
      const checked =
        input.profile === "sample" || input.profile === "final"
          ? checkProduction(checkFacts(output.technical), facts.context, facts.parameters)
          : ordinaryChecks(output.technical, input.profile, adKind);
      const context = facts.context;
      const snapshot = context
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
      const data = {
        profile: input.profile,
        ruleVersion: input.ruleVersion,
        gate: checked.gate,
        hard: requiredJson(checked.hard),
        soft: requiredJson(checked.soft),
        contextSnapshot: json(snapshot),
        checkedAt: now,
        updatedAt: now,
      };
      await tx.mediaCheck.upsert({
        where: { fileId: facts.file.id },
        create: { fileId: facts.file.id, ...data, createdAt: now },
        update: data,
      });
      if (facts.production) {
        const ai =
          facts.context?.aiUsed ?? (facts.production.aiUsage as { used?: boolean }).used === true;
        await tx.productionRecord.update({
          where: { fileId: facts.file.id },
          data: {
            pipelineState: checked.gate === "pass" ? "ready" : "rejected",
            aigcState: ai ? (output.technical.aigcMeta ? "verified" : "failed") : "not_required",
            aigcOrigin: output.technical.aigcMeta
              ? (facts.production.aigcOrigin ?? "upstream")
              : null,
            updatedAt: now,
          },
        });
        await emitChecked(deps, tx, ctx, facts, checked.gate, output.technical.durationMs);
        await deps.production?.productionChecked?.(tx, {
          fileId: facts.file.id,
          gate: checked.gate,
          derivedFromFileId: facts.production.derivedFromFileId,
        });
        if (ai && !output.technical.aigcMeta && !output.technical.invalidAigc && deps.production) {
          const next = await enqueueDerivation(deps, tx, facts.file.id, "restamp");
          return [next];
        }
        if (checked.gate === "pass" && facts.production.kind === "sample" && deps.production)
          return [await enqueueSampleWatermark(deps, tx, facts.file.id)];
      } else if (facts.file.uploadBatchId) {
        await deps.production?.productionChecked?.(tx, {
          fileId: facts.file.id,
          gate: checked.gate,
          derivedFromFileId: null,
        });
      }
    },
  };
}
