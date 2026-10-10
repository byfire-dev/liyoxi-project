import { z } from "zod";
import type { MediaJob, StoreAsset } from "@liyoxi/db";
import type { Prisma } from "@liyoxi/db";
import { calendarDate, minuteOfDay } from "@liyoxi/shared/time";
import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { jobBudget } from "../jobs/policy.js";
import type { JobJson, MediaJobKind } from "../jobs/types.js";
import { nextAssetSteps, assetFileSteps } from "./steps.js";
import type { AssetType } from "./steps.js";
import { assetFiles, rebuildAssetSearch } from "./repo.js";
import type { AssetDeps } from "./context.js";
import { assetPromptVersion } from "./types.js";

export const AssetJobInputSchema = z.strictObject({
  assetMarker: z.literal("store_asset_v1"),
  assetId: z.uuid(),
  fileId: z.uuid().nullable(),
  promptVersion: z.number().int().min(1).max(32767),
  runId: z.uuid(),
  selected: z
    .array(z.enum(["transcript", "vision", "doc_text", "structured_items", "digest", "tech_spec"]))
    .max(6),
  etag: z.string().nullable(),
  crc64: z.string().nullable(),
  sizeBytes: z.string().regex(/^\d+$/).nullable(),
  coverFileId: z.uuid(),
});
export const AssetJobOutputSchema = z.strictObject({
  status: z.enum(["ok", "skipped", "failed"]),
  reason: z
    .string()
    .regex(/^[a-zA-Z0-9_]{1,100}$/)
    .nullable(),
  content: z.record(z.string(), z.json()),
  verdict: z.enum(["pass", "review", "block", "pending"]).nullable(),
  probe: z.json().optional(),
  reusedFromId: z.uuid().optional(),
});
export type AssetJobInput = z.infer<typeof AssetJobInputSchema>;
export const insightForKind: Partial<Record<MediaJobKind, string>> = {
  probe: "tech_spec",
  asr: "transcript",
  vision: "vision",
  doc_extract: "doc_text",
  digest: "digest",
};
export function assetJobOwned(job: MediaJob): boolean {
  const parsed = AssetJobInputSchema.safeParse(job.input);
  return (
    parsed.success &&
    job.parentType === "store_asset" &&
    job.parentId === parsed.data.assetId &&
    job.subjectType === (parsed.data.fileId ? "file_object" : "store_asset") &&
    job.subjectId === (parsed.data.fileId ?? parsed.data.assetId) &&
    job.dedupeKey ===
      `asset:${parsed.data.assetId}:${parsed.data.runId}:${job.kind}:${parsed.data.fileId ?? "text"}:v${parsed.data.promptVersion}`
  );
}
const asJson = (value: unknown) => value as Prisma.InputJsonValue;
export async function currentAssetRun(tx: Tx, assetId: string) {
  const job = await tx.mediaJob.findFirst({
    where: { parentType: "store_asset", parentId: assetId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return job ? (AssetJobInputSchema.safeParse(job.input).data ?? null) : null;
}

/** Caller already holds the asset row. No external calls or synthetic flow transitions. */
export async function advanceAsset(
  tx: Tx,
  deps: AssetDeps,
  assetId: string,
  requested?: { runId: string; selected: string[] },
) {
  const asset = await tx.storeAsset.findUnique({ where: { id: assetId } });
  if (!asset || asset.deletedAt || asset.processingState === "processed") return;
  const run = requested ?? (await currentAssetRun(tx, assetId)) ?? { runId: assetId, selected: [] };
  const links = await assetFiles(tx, assetId);
  const jobs = await tx.mediaJob.findMany({
    where: { parentType: "store_asset", parentId: assetId },
    orderBy: { id: "asc" },
  });
  const currentJobs = jobs.filter(
    (job) => AssetJobInputSchema.safeParse(job.input).data?.runId === run.runId,
  );
  const insights = await tx.storeAssetInsight.findMany({
    where: { storeAssetId: assetId, promptVersion: assetPromptVersion },
  });
  const ownJobIds = new Set(currentJobs.map((job) => job.id));
  const considered = insights.filter(
    (row) =>
      (run.runId === asset.id && !run.selected.length) ||
      (run.selected.length > 0 && !run.selected.includes(row.kind)) ||
      (row.mediaJobId !== null && ownJobIds.has(row.mediaJobId)),
  );
  const plannedJobs = currentJobs.map((job) => ({
    kind: job.kind,
    state: job.state,
    fileId: AssetJobInputSchema.parse(job.input).fileId,
    promptVersion: assetPromptVersion,
  }));
  if (run.selected.length) {
    for (const file of asset.type === "text" ? [null] : links.map((link) => link.fileId)) {
      for (const kind of [
        ...assetFileSteps(
          asset.type as AssetType,
          asset.uploadActorType === "merchant" && asset.uploadClient === "weapp",
        ),
        "digest" as const,
      ]) {
        if (kind === "digest" && file !== null) continue;
        const insightKind = insightForKind[kind];
        if (
          !insightKind ||
          (!run.selected.includes(insightKind) &&
            !(kind === "digest" && run.selected.includes("structured_items")))
        )
          plannedJobs.push({
            kind,
            state: "succeeded",
            fileId: kind === "digest" ? null : file,
            promptVersion: assetPromptVersion,
          });
      }
    }
    if (!run.selected.includes("digest") && !run.selected.includes("structured_items"))
      plannedJobs.push({
        kind: "digest",
        state: "succeeded",
        fileId: null,
        promptVersion: assetPromptVersion,
      });
  }
  const decision = nextAssetSteps(
    {
      type: asset.type as AssetType,
      processingState: asset.processingState,
      moderationState: asset.moderationState,
      deleted: false,
      merchantImages: asset.uploadActorType === "merchant" && asset.uploadClient === "weapp",
      promptVersion: assetPromptVersion,
    },
    links.map((link) => ({ id: link.fileId })),
    considered,
    plannedJobs,
  );
  const now = deps.clock.now();
  for (const step of decision.create) {
    const file = links.find((link) => link.fileId === step.fileId)?.file;
    const input: AssetJobInput = {
      assetMarker: "store_asset_v1",
      assetId,
      fileId: step.fileId,
      promptVersion: assetPromptVersion,
      runId: run.runId,
      selected: run.selected as AssetJobInput["selected"],
      etag: file?.etag ?? null,
      crc64: file?.crc64 ?? null,
      sizeBytes: file?.sizeBytes?.toString() ?? null,
      coverFileId: uuidv7(),
    };
    const mode = ["audit_image_wx", "audit_video", "asr"].includes(step.kind) ? "remote" : "local";
    const provider =
      step.kind === "probe" || step.kind === "doc_extract"
        ? "mediatool"
        : step.kind === "audit_image_wx"
          ? "wechat"
          : step.kind === "asr"
            ? deps.assets.asr.status
            : ["vision", "digest"].includes(step.kind)
              ? deps.assets.llm.status
              : (deps.moderation?.status ?? "unconfigured");
    await tx.mediaJob.createMany({
      data: [
        {
          id: uuidv7(),
          kind: step.kind,
          provider,
          mode,
          parentType: "store_asset",
          parentId: assetId,
          subjectType: step.fileId ? "file_object" : "store_asset",
          subjectId: step.fileId ?? assetId,
          dedupeKey: `asset:${assetId}:${run.runId}:${step.kind}:${step.fileId ?? "text"}:v${assetPromptVersion}`,
          input: asJson(input),
          state: "queued",
          maxAttempts: 3,
          nextRunAt: now,
          deadlineAt: new Date(now.getTime() + jobBudget(step.kind)!.deadlineMs),
          createdAt: now,
          updatedAt: now,
        },
      ],
      skipDuplicates: true,
    });
  }
  if (!decision.settled) {
    await tx.storeAsset.update({
      where: { id: assetId },
      data: { processingState: "processing", updatedAt: now },
    });
    return;
  }
  const changed = await tx.storeAsset.updateMany({
    where: { id: assetId, processingState: { in: ["pending", "processing"] } },
    data: {
      processingState: "processed",
      isInsightPartial: decision.partial || asset.isInsightPartial,
      title:
        asset.title ??
        (() => {
          const label = {
            image: "图片",
            video: "视频",
            recording: "录音",
            audio: "音频",
            document: "文档",
            text: "文字",
          }[asset.type as AssetType];
          const duration = links.reduce(
            (total, link) => total + (link.file.mediaInfo?.durationMs ?? 0),
            0,
          );
          const amount =
            duration > 0 ? `${Math.ceil(duration / 1000)}秒` : `${links.length || 1}项`;
          const minute = minuteOfDay(asset.createdAt);
          const time = `${calendarDate(asset.createdAt).slice(5)} ${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
          return `${label}${amount} ${time}`;
        })(),
      updatedAt: now,
    },
  });
  if (!changed.count) return;
  await rebuildAssetSearch(
    tx,
    deps,
    await tx.storeAsset.findUniqueOrThrow({ where: { id: assetId } }),
  );
  const ctx = createIdentityContext({ actor: { type: "system", job: "media_job_run" } });
  await deps.events.emit(tx, ctx, {
    type: "asset.processed",
    aggregate: { type: "store_asset", id: assetId },
    entityId: asset.entityId,
    storeId: asset.storeId,
    payload: { v: 1, storeAssetId: assetId, entityId: asset.entityId, storeId: asset.storeId },
    dedupeKey: `asset.processed:${assetId}:${run.runId}`,
  });
  if (asset.reviewState === "unreviewed")
    await deps.events.emit(tx, ctx, {
      type: "asset.review_needed",
      aggregate: { type: "store_asset", id: assetId },
      entityId: asset.entityId,
      storeId: asset.storeId,
      payload: {
        v: 1,
        storeAssetId: assetId,
        storeId: asset.storeId,
        ...(asset.dueAt ? { dueAt: asset.dueAt.toISOString() } : {}),
      },
      dedupeKey: `asset.review_needed:${assetId}:${run.runId}`,
    });
}
export async function storeAssetInsight(
  tx: Tx,
  job: MediaJob,
  asset: StoreAsset,
  status: string,
  content: Record<string, JobJson>,
  reusedFromId?: string,
) {
  const input = AssetJobInputSchema.parse(job.input),
    kind = insightForKind[job.kind as MediaJobKind];
  if (!kind) return;
  const old = await tx.storeAssetInsight.findFirst({
    where: {
      storeAssetId: asset.id,
      fileId: input.fileId,
      kind,
      promptVersion: input.promptVersion,
    },
  });
  const now = job.finishedAt ?? job.updatedAt;
  const data = {
    provider: job.provider,
    status,
    content: asJson(content),
    mediaJobId: job.id,
    reusedFromStoreAssetInsightId: reusedFromId ?? null,
    updatedAt: now,
  };
  if (old) await tx.storeAssetInsight.update({ where: { id: old.id }, data });
  else
    await tx.storeAssetInsight.create({
      data: {
        id: uuidv7(),
        storeAssetId: asset.id,
        fileId: input.fileId,
        kind,
        promptVersion: input.promptVersion,
        ...data,
        createdAt: now,
      },
    });
}
