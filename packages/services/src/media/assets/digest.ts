import { createHash } from "node:crypto";
import { z } from "zod";
import type { MediaJob } from "@liyoxi/db";
import { assertNotInTransaction, lockRows } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
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

const sourceKind = { transcript: "asr", vision: "vision", doc_text: "doc_extract" } as const;
const points = z.strictObject({
  points: z
    .array(z.string().refine((v) => !!v.trim() && Array.from(v).length <= 60))
    .min(1)
    .max(6),
});
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
      const valid =
        origin &&
        facts &&
        assetJobOwned(origin) &&
        origin.state === "succeeded" &&
        origin.kind === sourceKind[kind] &&
        output?.status === "ok" &&
        row?.provider === origin.provider &&
        JSON.stringify(output.content) === JSON.stringify(row?.content) &&
        facts.assetId === asset.id &&
        facts.runId === input.runId &&
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
        } else if (kind === "vision") text = vision.safeParse(row.content).data?.description;
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
            : 2000;
      partial ||= chars.length > remaining;
      const selected = chars.slice(0, Math.max(0, remaining)).join("");
      if (kind === "transcript") transcriptChars += Array.from(selected).length;
      if (kind === "doc_text") documentChars += Array.from(selected).length;
      if (selected) pieces.push(`${kind}: ${selected}`);
    }
  const fullText = [asset.textBody, asset.note, tags.map((tag) => tag.tagCode).join(","), ...pieces]
    .filter(Boolean)
    .join("\n");
  partial ||= Array.from(fullText).length > 16000;
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        asset: [asset.id, asset.entityId, asset.storeId, asset.type, asset.textBody, asset.note],
        run: [input.runId, input.promptVersion],
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
      }),
    )
    .digest("hex");
  return {
    hash,
    text: usable ? Array.from(fullText).slice(0, 16000).join("") : "",
    partial,
    storeId: asset.storeId,
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
      const now = deps.clock.now();
      if (
        !fresh ||
        fresh.kind !== "digest" ||
        fresh.state !== "running" ||
        fresh.provider !== deps.assets.llm.status ||
        fresh.attemptNo !== job.attemptNo ||
        !job.leaseOwner ||
        fresh.leaseOwner !== job.leaseOwner ||
        fresh.nextRunAt <= now ||
        fresh.deadlineAt <= now ||
        JSON.stringify(fresh.input) !== JSON.stringify(job.input) ||
        !(await current(tx, fresh))
      )
        return null;
      const snapshot = await sources(tx, fresh);
      if (!snapshot) return null;
      const permitted =
        !model || !!(await deps.assets.allowModelCall?.(tx, { storeId: snapshot.storeId, now }));
      return { ...snapshot, permitted };
    });
  }
  return {
    async execute(job: MediaJob, signal: AbortSignal): Promise<JobOutcome> {
      if (signal.aborted) return { state: "canceled" };
      try {
        const before = await admitted(job, true);
        if (!before || signal.aborted) return { state: "canceled" };
        if (!before.permitted) return skipped("budget_unconfigured");
        if (deps.assets.llm.status === "unconfigured") return skipped("llm_unconfigured");
        if (!before.text.trim()) return skipped("digest_source_missing");
        assertNotInTransaction("素材要点模型调用");
        const result = await deps.assets.llm.extractKeyPoints({
          text: before.text,
          maxPoints: 6,
          signal,
        });
        const after = await admitted(job, false);
        if (signal.aborted || !after || before.hash !== after.hash) return { state: "canceled" };
        if (!result.ok) return skipped("digest_unavailable");
        const parsed = points.safeParse(result.value);
        if (!parsed.success) return skipped("digest_result_invalid");
        return {
          state: "succeeded",
          output: {
            status: "ok",
            reason: null,
            content: {
              keypoints: parsed.data.points,
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
      return !!snapshot && snapshot.hash === content.sourceHash;
    },
  };
}
