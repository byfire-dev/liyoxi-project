import type { MediaJobKind } from "../jobs/types.js";

export type AssetType = "image" | "video" | "recording" | "audio" | "document" | "text";
export type AssetInsightKind =
  "transcript" | "vision" | "doc_text" | "structured_items" | "digest" | "tech_spec";
export interface AssetStep {
  readonly kind: MediaJobKind;
  readonly fileId: string | null;
  readonly insightKind: AssetInsightKind | null;
}
export interface AssetStepInsight {
  readonly fileId: string | null;
  readonly kind: string;
  readonly promptVersion: number;
  readonly status: string;
}
export interface AssetStepJob {
  readonly kind: string;
  readonly fileId: string | null;
  readonly promptVersion: number;
  readonly state: string;
}
export interface AssetStepInput {
  readonly type: AssetType;
  readonly processingState: string;
  readonly moderationState: string;
  readonly deleted: boolean;
  readonly merchantImages: boolean;
  readonly promptVersion: number;
}
const terminal = new Set(["succeeded", "failed", "canceled"]);
const insightKinds: Partial<Record<MediaJobKind, AssetInsightKind>> = {
  probe: "tech_spec",
  asr: "transcript",
  vision: "vision",
  doc_extract: "doc_text",
  digest: "digest",
};

/** The ordering is the D5 §9 graph. A failed/skipped step releases its successor. */
export function assetFileSteps(type: AssetType, merchantImages: boolean): readonly MediaJobKind[] {
  switch (type) {
    case "image":
      return [merchantImages ? "audit_image_wx" : "audit_image", "vision"];
    case "video":
      return ["probe", "audit_video", "asr", "vision"];
    case "recording":
    case "audio":
      return ["probe", "asr", "audit_text"];
    case "document":
      return ["doc_extract", "audit_text"];
    case "text":
      return ["audit_text"];
  }
}

/** Pure and reentrant: callers hold the asset parent lock before applying this plan. */
export function nextAssetSteps(
  asset: AssetStepInput,
  files: readonly { readonly id: string }[],
  insights: readonly AssetStepInsight[],
  jobs: readonly AssetStepJob[],
): { readonly create: readonly AssetStep[]; readonly settled: boolean; readonly partial: boolean } {
  if (asset.deleted || asset.moderationState === "block")
    return { create: [], settled: true, partial: true };
  if (asset.processingState === "processed") return { create: [], settled: true, partial: false };
  const currentInsights = insights.filter((row) => row.promptVersion === asset.promptVersion);
  const currentJobs = jobs.filter((row) => row.promptVersion === asset.promptVersion);
  const create: AssetStep[] = [];
  let pending = false;
  let partial = currentInsights.some((row) => row.status !== "ok");
  const ended = (kind: MediaJobKind, fileId: string | null): boolean => {
    const job = currentJobs.find((row) => row.kind === kind && row.fileId === fileId);
    const insightKind = insightKinds[kind];
    const insight = insightKind
      ? currentInsights.find((row) => row.kind === insightKind && row.fileId === fileId)
      : undefined;
    if (insight || (job && terminal.has(job.state))) {
      partial ||= insight?.status !== "ok" && !!insight;
      partial ||= job?.state === "failed" || job?.state === "canceled";
      return true;
    }
    pending = true;
    if (!job) create.push({ kind, fileId, insightKind: insightKind ?? null });
    return false;
  };
  const subjects: readonly (string | null)[] =
    asset.type === "text" ? [null] : files.map((file) => file.id);
  if (subjects.length === 0) return { create: [], settled: false, partial: true };
  for (const fileId of subjects) {
    for (const kind of assetFileSteps(asset.type, asset.merchantImages)) {
      if (!ended(kind, fileId)) break;
    }
  }
  if (!pending) ended("digest", null);
  return { create, settled: !pending, partial };
}

export function assetDisplayStatus(
  processingState: string,
  reviewState: string,
  usability: string | null,
  adoptedCount: number,
): string {
  if (processingState !== "processed" || reviewState !== "reviewed") return "organizing";
  return adoptedCount > 0 ? "adopted" : (usability ?? "organizing");
}

export function assetSelectable(asset: {
  readonly deletedAt: Date | null;
  readonly moderationState: string;
  readonly usability: string | null;
}): boolean {
  return (
    !asset.deletedAt && asset.moderationState !== "block" && asset.usability !== "need_reshoot"
  );
}
