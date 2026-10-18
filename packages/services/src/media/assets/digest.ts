import { createHash } from "node:crypto";
import { z } from "zod";
import type { MediaJob } from "@liyoxi/db";
import { AssetTagExtSchema, DictCodeSchema } from "@liyoxi/contract";
import { assertNotInTransaction, lockRows } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { LlmDigestSchema, LlmVisionSchema, isLlmDigestInput } from "../../providers/types.js";
import type { LlmDigestVocabulary } from "../../providers/types.js";
import type { JobJson, JobOutcome } from "../jobs/types.js";
import type { AssetDeps } from "./context.js";
import {
  AssetJobInputSchema,
  AssetJobOutputSchema,
  assetJobOwned,
  currentAssetRun,
} from "./pipeline.js";
import { assetFiles } from "./repo.js";
import { documentFacts } from "./doc.js";
import { visionContent, visionProjection } from "./vision.js";
import {
  admitModel,
  hasModelBudget,
  completeModelBudget,
  modelBudgetFailure,
  readModelJob,
  modelPermitCurrent,
} from "./model-admission.js";
import type { ModelBudgetContext } from "./model-budget.js";

const sourceKind = { transcript: "asr", vision: "vision", doc_text: "doc_extract" } as const;
const vocabularyItem = z.object({ code: DictCodeSchema, name: z.string().min(1).max(20) });
/** Only job output carries private completion facts; the persisted insight is the strict DTO. */
export function digestContent(content: Readonly<Record<string, JobJson>>) {
  const { partial, sourceHash, ...value } = content;
  if (
    typeof partial !== "boolean" ||
    typeof sourceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(sourceHash)
  )
    return undefined;
  return LlmDigestSchema.safeParse(value).data;
}
const vision = z.object({
  description: z.string().trim().min(1).max(2000),
  tags: z.array(z.string().trim().min(1).max(100)).max(20),
});
const transcript = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(4 * 1024 ** 2),
    durationSec: z.number().finite().positive().max(18000),
    segments: z
      .array(
        z.object({
          text: z.string().trim().min(1),
          fromMs: z.number().int().nonnegative(),
          toMs: z.number().int().positive(),
        }),
      )
      .min(1)
      .max(100000),
  })
  .refine((v) =>
    v.segments.every((s) => s.toMs > s.fromMs && s.toMs <= Math.ceil(v.durationSec * 1000)),
  );
const skipped = (reason: string): JobOutcome => ({
  state: "succeeded",
  output: { status: "skipped", reason, content: {}, verdict: null },
});

/** One asset/run's real inputs; the hash binds full sources, including discarded suffixes. */
async function sources(tx: Tx, job: MediaJob) {
  const input = AssetJobInputSchema.parse(job.input);
  const asset = await tx.storeAsset.findUniqueOrThrow({ where: { id: input.assetId } });
  const run = await currentAssetRun(tx, asset.id);
  if (!run || run.runId !== input.runId || run.promptVersion !== input.promptVersion) return null;
  const links = await assetFiles(tx, asset.id);
  if (
    links.some(
      ({ file }) =>
        file.entityId !== asset.entityId ||
        file.storeId !== asset.storeId ||
        file.category !== "store_asset" ||
        file.bucket !== "asset" ||
        file.status !== "stored" ||
        file.moderationState === "block" ||
        !file.etag ||
        file.sizeBytes === null ||
        file.sizeBytes <= 0n,
    )
  )
    return null;
  const rows = await tx.storeAssetInsight.findMany({
    where: {
      storeAssetId: asset.id,
      kind: { in: Object.keys(sourceKind) },
      promptVersion: input.promptVersion,
    },
    orderBy: { id: "asc" },
  });
  const jobs = await tx.mediaJob.findMany({
    where: { id: { in: rows.flatMap((row) => (row.mediaJobId ? [row.mediaJobId] : [])) } },
    orderBy: { id: "asc" },
  });
  const tags = await tx.storeAssetTag.findMany({
    where: { storeAssetId: asset.id, source: "uploader", dimension: "content" },
    orderBy: { id: "asc" },
  });
  const dictionary = await tx.dictItem.findMany({
    where: { dictTypeKey: "asset_tag", isEnabled: true },
    orderBy: { code: "asc" },
    take: 769,
  });
  const vocabulary: Record<keyof LlmDigestVocabulary, Array<{ code: string; label: string }>> = {
    content: [],
    usage: [],
    timeliness: [],
  };
  let vocabularyValid = dictionary.length <= 768;
  for (const row of dictionary) {
    const item = vocabularyItem.safeParse(row).data;
    const dimension = AssetTagExtSchema.safeParse(row.ext).data?.dimension;
    if (!item || !dimension) {
      vocabularyValid = false;
      continue;
    }
    // The owned snapshot is constructed here and never exposed before the IO boundary.
    const entries = vocabulary[dimension];
    entries.push({ code: item.code, label: item.name });
    if (entries.length > 256) vocabularyValid = false;
  }
  const expected: readonly (keyof typeof sourceKind)[] =
    asset.type === "document"
      ? ["doc_text"]
      : asset.type === "image"
        ? ["vision"]
        : asset.type === "video"
          ? ["transcript", "vision"]
          : ["audio", "recording"].includes(asset.type)
            ? ["transcript"]
            : [];
  const pieces: string[] = [];
  const pieceFiles: Array<{ fileId: string; prefix: number }> = [];
  let partial = false,
    usable = !!(asset.textBody?.trim() || asset.note?.trim()),
    transcriptChars = 0,
    documentChars = 0;
  for (const { file } of links)
    for (const kind of expected) {
      const row = rows.find(
        (row) => row.fileId === file.id && row.kind === kind && row.status === "ok",
      );
      const origin = jobs.find((origin) => origin.id === row?.mediaJobId);
      const facts = origin && AssetJobInputSchema.safeParse(origin.input).data;
      const output = origin && AssetJobOutputSchema.safeParse(origin.output).data;
      const modernContent =
        kind === "vision" ? LlmVisionSchema.safeParse(row?.content).data : undefined;
      const modernVision = !!modernContent;
      const originContent = modernVision ? visionContent(output?.content) : output?.content;
      const valid =
        origin &&
        facts &&
        assetJobOwned(origin) &&
        origin.state === "succeeded" &&
        origin.kind === sourceKind[kind] &&
        output?.status === "ok" &&
        row?.provider === origin.provider &&
        JSON.stringify(originContent) === JSON.stringify(modernContent ?? row?.content) &&
        facts.assetId === asset.id &&
        (facts.runId === run.runId || (run.selected.length > 0 && !run.selected.includes(kind))) &&
        facts.promptVersion === input.promptVersion &&
        facts.fileId === file.id &&
        facts.etag === file.etag &&
        facts.crc64 === file.crc64 &&
        facts.sizeBytes === file.sizeBytes?.toString();
      let text: string | undefined;
      if (valid && row) {
        if (kind === "doc_text") {
          const value = documentFacts(row.content, file.ext);
          text = value?.text;
          partial ||= value?.truncated === true;
        } else if (kind === "vision")
          text = modernVision
            ? visionProjection(row.content)
            : vision.safeParse(row.content).data?.description;
        else text = transcript.safeParse(row.content).data?.text;
      }
      if (!text) {
        partial = true;
        continue;
      }
      usable = true;
      const chars = Array.from(text);
      const remaining =
        kind === "transcript"
          ? 6000 - transcriptChars
          : kind === "doc_text"
            ? 8000 - documentChars
            : modernVision
              ? 16000
              : 2000;
      partial ||= chars.length > remaining;
      const selected = chars.slice(0, Math.max(0, remaining)).join("");
      if (kind === "transcript") transcriptChars += Array.from(selected).length;
      if (kind === "doc_text") documentChars += Array.from(selected).length;
      if (selected) {
        pieces.push(`${kind}: ${selected}`);
        pieceFiles.push({ fileId: file.id, prefix: kind.length + 2 });
      }
    }
  const fullText = [asset.textBody, asset.note, tags.map((tag) => tag.tagCode).join(","), ...pieces]
    .filter(Boolean)
    .join("\n");
  partial ||= Array.from(fullText).length > 16000;
  // 前缀/换行/文本/说明/标签都占原布局；只有实际保留洞察正文字符才计文件。
  const base = [asset.textBody, asset.note, tags.map((tag) => tag.tagCode).join(",")].filter(
    Boolean,
  );
  let offset = Array.from(base.join("\n")).length;
  const contributing = new Set<string>();
  for (const [index, piece] of pieces.entries()) {
    if (base.length || index > 0) offset += 1;
    if (offset + pieceFiles[index]!.prefix < 16000) contributing.add(pieceFiles[index]!.fileId);
    offset += Array.from(piece).length;
  }
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        asset: [asset.id, asset.entityId, asset.storeId, asset.type, asset.textBody, asset.note],
        run: [run.runId, run.promptVersion, run.selected],
        files: links.map(({ file, position }) => [
          position,
          file.id,
          file.objectKey,
          file.ext,
          file.etag,
          file.crc64,
          file.sha256,
          file.sizeBytes?.toString(),
          file.moderationState,
        ]),
        rows: rows.map((row) => [
          row.id,
          row.fileId,
          row.kind,
          row.status,
          row.provider,
          row.content,
          row.mediaJobId,
        ]),
        jobs: jobs.map((row) => [
          row.id,
          row.kind,
          row.provider,
          row.parentType,
          row.parentId,
          row.subjectType,
          row.subjectId,
          row.dedupeKey,
          row.state,
          row.input,
          row.output,
          row.attemptNo,
        ]),
        tags: tags.map((row) => [row.id, row.tagCode]),
        dictionary: dictionary.map((row) => [row.id, row.code, row.name, row.ext, row.updatedAt]),
      }),
    )
    .digest("hex");
  return {
    hash,
    text: usable ? Array.from(fullText).slice(0, 16000).join("") : "",
    partial,
    entityId: asset.entityId,
    storeId: asset.storeId,
    fileIds: [...contributing].sort(),
    vocabulary: vocabularyValid ? vocabulary : null,
  };
}

/** No model admission or source error may escape into the generic automatic retry path. */
export function createAssetDigestStrategy(
  deps: AssetDeps,
  current: (tx: Tx, job: MediaJob) => Promise<boolean>,
) {
  async function admitted(job: MediaJob, model: boolean) {
    if (job.kind !== "digest" || job.state !== "running" || !assetJobOwned(job)) return null;
    const input = AssetJobInputSchema.parse(job.input);
    return deps.tx.run(async (tx) => {
      await lockRows(tx, "store_asset", [input.assetId]);
      await lockRows(tx, "media_job", [job.id]);
      const fresh = await tx.mediaJob.findUnique({ where: { id: job.id } });
      if (
        !fresh ||
        fresh.kind !== "digest" ||
        fresh.state !== "running" ||
        fresh.provider !== deps.assets.llm.status ||
        fresh.attemptNo !== job.attemptNo ||
        !job.leaseOwner ||
        fresh.leaseOwner !== job.leaseOwner ||
        JSON.stringify(fresh.input) !== JSON.stringify(job.input) ||
        !(await current(tx, fresh))
      )
        return null;
      const snapshot = await sources(tx, fresh);
      const now = deps.clock.now();
      if (!snapshot || fresh.nextRunAt <= now || fresh.deadlineAt <= now) return null;
      const permitted =
        !model || !!(await deps.assets.allowModelCall?.(tx, { storeId: snapshot.storeId, now }));
      return { ...snapshot, permitted };
    });
  }
  return {
    async execute(job: MediaJob, signal: AbortSignal): Promise<JobOutcome> {
      if (signal.aborted) return { state: "canceled" };
      try {
        const paired = hasModelBudget(deps);
        if (paired && !completeModelBudget(deps)) return modelBudgetFailure("unavailable");
        const before = await admitted(job, !paired);
        if (!before || signal.aborted) return { state: "canceled" };
        if (!before.permitted) return skipped("budget_unconfigured");
        if (deps.assets.llm.status === "unconfigured") return skipped("llm_unconfigured");
        const vocabulary = before.vocabulary;
        if (!vocabulary) return skipped("digest_vocabulary_invalid");
        if (!before.text.trim()) return skipped("digest_source_missing");
        if (Buffer.byteLength(JSON.stringify({ evidence: before.text, vocabulary })) > 64 * 1024)
          return skipped("digest_input_invalid");
        const modelInput = { text: before.text, vocabulary: structuredClone(vocabulary), signal };
        let permit: ModelBudgetContext | undefined;
        if (paired) {
          if (!isLlmDigestInput(modelInput)) return skipped("digest_input_invalid");
          const outcome = await admitModel(deps, job, signal, async (tx) => {
            if (!(await readModelJob(deps, tx, job, current))) return null;
            const snapshot = await sources(tx, job);
            return snapshot?.hash === before.hash
              ? {
                  entityId: snapshot.entityId,
                  storeId: snapshot.storeId,
                  fileIds: snapshot.fileIds,
                  expectedSourceHash: snapshot.hash,
                }
              : null;
          });
          if ("state" in outcome) return outcome;
          permit = outcome.permit;
        }
        assertNotInTransaction("素材结构化摘要模型调用");
        if (permit && !modelPermitCurrent(deps, permit, signal)) return { state: "canceled" };
        const result = await deps.assets.llm.summarizeAsset(modelInput);
        const after = await admitted(job, false);
        if (signal.aborted || !after || before.hash !== after.hash) return { state: "canceled" };
        if (!result.ok) return skipped("digest_unavailable");
        const parsed = LlmDigestSchema.safeParse(result.value);
        if (!parsed.success || !z.json().safeParse(parsed.data).success)
          return skipped("digest_result_invalid");
        const { suggestedTimeliness, ...fields } = parsed.data;
        const known = (dimension: keyof LlmDigestVocabulary, code: string) =>
          vocabulary[dimension].some((item) => item.code === code);
        const value = {
          ...fields,
          contentTags: fields.contentTags.filter((code) => known("content", code)),
          suggestedUsage: fields.suggestedUsage.filter((code) => known("usage", code)),
          ...(suggestedTimeliness && known("timeliness", suggestedTimeliness.code)
            ? { suggestedTimeliness }
            : {}),
        };
        return {
          state: "succeeded",
          output: {
            status: "ok",
            reason: null,
            content: {
              ...value,
              partial: before.partial,
              sourceHash: before.hash,
            },
            verdict: null,
          },
        };
      } catch {
        return signal.aborted ? { state: "canceled" } : skipped("digest_unavailable");
      }
    },
    async matches(tx: Tx, job: MediaJob, content: Readonly<Record<string, JobJson>>) {
      const snapshot = await sources(tx, job);
      const now = deps.clock.now();
      const value = digestContent(content);
      const known = (dimension: keyof LlmDigestVocabulary, code: string) =>
        snapshot?.vocabulary?.[dimension].some((item) => item.code === code);
      return (
        job.deadlineAt > now &&
        job.nextRunAt > now &&
        !!snapshot?.vocabulary &&
        !!value &&
        snapshot.hash === content.sourceHash &&
        value.contentTags.every((code) => known("content", code)) &&
        value.suggestedUsage.every((code) => known("usage", code)) &&
        (!value.suggestedTimeliness || known("timeliness", value.suggestedTimeliness.code))
      );
    },
  };
}
