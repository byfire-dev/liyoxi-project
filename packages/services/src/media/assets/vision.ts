import { createHash } from "node:crypto";
import { z } from "zod";
import type { MediaJob } from "@liyoxi/db";
import { AppError, assertNotInTransaction, lockRows } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { LlmVisionSchema } from "../../providers/types.js";
import type { JobJson, JobOutcome } from "../jobs/types.js";
import { ProbeOutputSchema } from "../handlers/probe.js";
import type { AssetDeps } from "./context.js";
import { assetFiles, lockAssetFiles } from "./repo.js";
import {
  AssetJobInputSchema,
  AssetJobOutputSchema,
  assetJobOwned,
  currentAssetRun,
} from "./pipeline.js";

const completion = LlmVisionSchema.extend({
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  frameAtMs: z.array(z.number().int().nonnegative().max(2_147_483_647)).max(14),
  cacheSourceId: z.uuid().nullable(),
}).strict();
const json = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
        )
      : item,
  );
const hash = (value: unknown) => createHash("sha256").update(json(value)).digest("hex");
const same = (left: unknown, right: unknown) => json(left) === json(right);
const skipped = (reason: string): JobOutcome => ({
  state: "succeeded",
  output: { status: "skipped", reason, content: {}, verdict: null },
});

/** 请求等分区间中心，不冒充取得的帧PTS或逐帧模型结果。 */
export function visionFrameTimes(durationMs: unknown): number[] | undefined {
  if (
    typeof durationMs !== "number" ||
    !Number.isInteger(durationMs) ||
    durationMs < 6 ||
    durationMs > 2_147_483_647
  )
    return undefined;
  const count = Math.min(14, 6 + 2 * Math.ceil(Math.max(0, durationMs / 60_000 - 1)));
  const times = Array.from({ length: count }, (_, i) =>
    Math.floor(((2 * i + 1) * durationMs) / (2 * count)),
  );
  return times.every((time, i) => time < durationMs && (i === 0 || time > times[i - 1]!))
    ? times
    : undefined;
}

/** 任务私有来源与请求时间不得落业务洞察。 */
export function visionContent(value: unknown) {
  const result = completion.safeParse(value);
  if (!result.success) return undefined;
  const { sourceHash: _hash, frameAtMs: _times, cacheSourceId: _cache, ...content } = result.data;
  return content;
}

/** 显式可见事实供摘要消费；布尔提示本身不伪装成正文或授权。 */
export function visionProjection(value: unknown): string | undefined {
  const content = LlmVisionSchema.safeParse(value).data;
  if (
    !content ||
    ![content.description, content.quality, content.textInImage].some((v) => v.trim())
  )
    return undefined;
  return [
    `description: ${content.description}`,
    `quality: ${content.quality}`,
    `textInImage: ${content.textInImage}`,
    `hasPeople: ${content.hasPeople}`,
    `identifiableCustomerFace: ${content.identifiableCustomerFace}`,
  ].join("\n");
}

async function discover(tx: Tx, assetId: string) {
  const asset = await tx.storeAsset.findUnique({ where: { id: assetId } });
  const active = await tx.mediaJob.findFirst({
    where: { parentType: "store_asset", parentId: assetId, kind: "vision", state: "running" },
  });
  const queued =
    active ??
    (await tx.mediaJob.findFirst({
      where: { parentType: "store_asset", parentId: assetId, kind: "vision", state: "queued" },
    }));
  const input = queued && AssetJobInputSchema.safeParse(queued.input).data;
  const links = await assetFiles(tx, assetId);
  const fingerprints = links.flatMap(({ file }) =>
    file.crc64 && file.sizeBytes !== null ? [{ crc64: file.crc64, sizeBytes: file.sizeBytes }] : [],
  );
  const candidates =
    asset && input && fingerprints.length
      ? await tx.storeAssetInsight.findMany({
          where: {
            kind: "vision",
            status: "ok",
            promptVersion: input.promptVersion,
            storeAssetId: { not: assetId },
            reusedFromStoreAssetInsightId: null,
            storeAsset: {
              entityId: asset.entityId,
              type: asset.type,
              deletedAt: null,
              moderationState: { not: "block" },
            },
            file: {
              entityId: asset.entityId,
              status: "stored",
              moderationState: { not: "block" },
              OR: fingerprints,
            },
          },
          orderBy: { id: "asc" },
          take: 32,
        })
      : [];
  return {
    assetId,
    ids: [...new Set([assetId, ...candidates.map((row) => row.storeAssetId)])].sort(),
    candidates,
  };
}
type Graph = Awaited<ReturnType<typeof discover>>;
const graphs = new WeakMap<Tx, Graph>();
const graphKey = (graph: Graph) => [graph.ids, graph.candidates.map((row) => row.id)];

/** 只有父370预锁：runner仍按本次实际job取得400，不预锁无界历史任务。 */
export async function lockVisionParents(tx: Tx, assetId: string): Promise<void> {
  const before = await discover(tx, assetId);
  await lockRows(tx, "store_asset", before.ids);
  const after = await discover(tx, assetId);
  if (!same(graphKey(before), graphKey(after))) throw new AppError("BUSY");
  graphs.set(tx, after);
}

/** 仅vision消费全图410；终态origin由其父370保护，不假定原生SQL遵循锁协议。 */
export async function lockVisionFiles(tx: Tx, job: MediaJob): Promise<void> {
  const input = AssetJobInputSchema.parse(job.input);
  if (!graphs.has(tx)) await lockVisionParents(tx, input.assetId);
  const graph = graphs.get(tx)!;
  if (graph.assetId !== input.assetId) throw new AppError("BUSY");
  if (job.state !== "succeeded") {
    const fresh = await discover(tx, input.assetId);
    if (!same(graphKey(graph), graphKey(fresh))) throw new AppError("BUSY");
  }
  const links = await tx.storeAssetFile.findMany({
    where: { storeAssetId: { in: graph.ids } },
    include: { file: { include: { mediaInfo: true } } },
    orderBy: [{ storeAssetId: "asc" }, { position: "asc" }],
  });
  const ids = links.flatMap(({ file }) => [
    file.id,
    ...(file.mediaInfo?.coverFileId ? [file.mediaInfo.coverFileId] : []),
  ]);
  await lockAssetFiles(tx, [...ids, input.coverFileId]);
  const reread = await tx.storeAssetFile.findMany({
    where: { storeAssetId: { in: graph.ids } },
    orderBy: [{ storeAssetId: "asc" }, { position: "asc" }],
  });
  if (
    !same(
      links.map((row) => [row.storeAssetId, row.fileId, row.position]).sort(),
      reread.map((row) => [row.storeAssetId, row.fileId, row.position]).sort(),
    )
  )
    throw new AppError("BUSY");
}

async function source(deps: AssetDeps, tx: Tx, job: MediaJob, historical = false) {
  if (job.kind !== "vision" || !assetJobOwned(job)) return null;
  const input = AssetJobInputSchema.parse(job.input);
  const asset = await tx.storeAsset.findUnique({ where: { id: input.assetId } });
  if (
    !asset ||
    !["image", "video"].includes(asset.type) ||
    asset.deletedAt ||
    asset.moderationState === "block" ||
    (!historical && asset.processingState === "processed")
  )
    return null;
  const run = await currentAssetRun(tx, asset.id);
  if (
    !run ||
    run.promptVersion !== input.promptVersion ||
    (run.runId !== input.runId &&
      !(historical && run.selected.length && !run.selected.includes("vision")))
  )
    return null;
  if (run.runId === input.runId && !same(run.selected, input.selected)) return null;
  const store = await deps.assets.readStore(tx, asset.storeId);
  if (
    !store ||
    store.id !== asset.storeId ||
    store.entityId !== asset.entityId ||
    store.lifecycle !== "active"
  )
    return null;
  const links = await assetFiles(tx, asset.id);
  const file = links.find((row) => row.fileId === input.fileId)?.file;
  if (
    !file ||
    file.entityId !== asset.entityId ||
    file.storeId !== asset.storeId ||
    file.scopeType !== "store" ||
    file.category !== "store_asset" ||
    file.bucket !== "asset" ||
    !(asset.type === "image" ? ["jpg", "jpeg", "png"] : ["mp4", "mov"]).includes(file.ext) ||
    file.status !== "stored" ||
    file.moderationState === "block" ||
    !file.etag ||
    file.sizeBytes === null ||
    file.sizeBytes <= 0n ||
    file.etag !== input.etag ||
    file.crc64 !== input.crc64 ||
    file.sizeBytes.toString() !== input.sizeBytes
  )
    return null;
  let probe: unknown = null;
  let frameAtMs: number[] = [];
  if (asset.type === "video") {
    const row = await tx.storeAssetInsight.findFirst({
      where: {
        storeAssetId: asset.id,
        fileId: file.id,
        kind: "tech_spec",
        promptVersion: input.promptVersion,
        status: "ok",
      },
    });
    const origin = row?.mediaJobId
      ? await tx.mediaJob.findUnique({ where: { id: row.mediaJobId } })
      : null;
    const facts = origin && AssetJobInputSchema.safeParse(origin.input).data;
    const output = origin && AssetJobOutputSchema.safeParse(origin.output).data;
    const parsed = output && ProbeOutputSchema.safeParse(output.probe).data;
    const info = file.mediaInfo;
    if (
      !origin ||
      !facts ||
      !parsed ||
      !info ||
      !assetJobOwned(origin) ||
      origin.kind !== "probe" ||
      origin.provider !== "mediatool" ||
      origin.state !== "succeeded" ||
      output?.status !== "ok" ||
      row?.provider !== origin.provider ||
      !same(row.content, output.content) ||
      facts.assetId !== asset.id ||
      facts.fileId !== file.id ||
      facts.promptVersion !== input.promptVersion ||
      (facts.runId !== run.runId &&
        !(run.selected.length && !run.selected.includes("tech_spec"))) ||
      facts.etag !== file.etag ||
      facts.crc64 !== file.crc64 ||
      facts.sizeBytes !== file.sizeBytes.toString() ||
      parsed.sourceSha256 !== file.sha256 ||
      parsed.technical.kind !== "video" ||
      parsed.technical.sizeBytes !== Number(file.sizeBytes) ||
      info.coverFileId !== (parsed.cover?.id ?? null) ||
      info.probeVersion !== 1 ||
      info.probedAt.getTime() !== origin.finishedAt?.getTime()
    )
      return null;
    const {
      bitDepth: _depth,
      sizeBytes: _size,
      invalidAigc: _invalid,
      vfr: _vfr,
      aigcMeta,
      raw,
      ...columns
    } = parsed.technical;
    if (
      Object.entries(columns).some(
        ([key, value]) => !same((info as unknown as Record<string, unknown>)[key], value),
      ) ||
      !same(info.aigcMeta, aigcMeta) ||
      !same(info.raw, raw)
    )
      return null;
    const times = visionFrameTimes(info.durationMs);
    if (!times) return null;
    frameAtMs = times;
    probe = [
      row,
      origin.id,
      origin.provider,
      origin.parentType,
      origin.parentId,
      origin.subjectType,
      origin.subjectId,
      origin.dedupeKey,
      origin.input,
      origin.output,
      origin.attemptNo,
      info,
    ];
  }
  const fingerprint = (value: typeof file) => [
    value.id,
    value.entityId,
    value.storeId,
    value.scopeType,
    value.category,
    value.bucket,
    value.objectKey,
    value.ext,
    value.etag,
    value.crc64,
    value.sha256,
    value.sizeBytes?.toString(),
    value.status,
    value.moderationState,
  ];
  return {
    asset,
    file,
    run,
    frameAtMs,
    hash: hash([
      input,
      [
        job.id,
        job.kind,
        job.provider,
        job.parentType,
        job.parentId,
        job.subjectType,
        job.subjectId,
        job.dedupeKey,
        job.attemptNo,
      ],
      [asset.id, asset.entityId, asset.storeId, asset.type],
      links.map((row) => [row.storeAssetId, row.position, fingerprint(row.file)]),
      probe,
      frameAtMs,
    ]),
  };
}

async function cached(
  deps: AssetDeps,
  tx: Tx,
  target: NonNullable<Awaited<ReturnType<typeof source>>>,
  id?: string,
) {
  const graph = graphs.get(tx);
  for (const candidate of graph?.candidates ?? []) {
    if (id && candidate.id !== id) continue;
    if (!candidate.mediaJobId || candidate.fileId === null) continue;
    const row = await tx.storeAssetInsight.findUnique({ where: { id: candidate.id } });
    const origin = row?.mediaJobId
      ? await tx.mediaJob.findUnique({ where: { id: row.mediaJobId } })
      : null;
    const output = origin && AssetJobOutputSchema.safeParse(origin.output).data;
    const privateFacts = output && completion.safeParse(output.content).data;
    const content = output && visionContent(output.content);
    if (
      !row ||
      !origin ||
      !privateFacts ||
      !content ||
      row.status !== "ok" ||
      row.kind !== "vision" ||
      row.promptVersion !== target.run.promptVersion ||
      row.reusedFromStoreAssetInsightId ||
      origin.state !== "succeeded" ||
      output?.status !== "ok" ||
      output.reusedFromId ||
      privateFacts.cacheSourceId !== null ||
      row.provider !== origin.provider ||
      !same(row.content, content)
    )
      continue;
    const original = await source(deps, tx, origin, true);
    if (
      !original ||
      original.asset.id !== row.storeAssetId ||
      original.file.id !== row.fileId ||
      original.asset.entityId !== target.asset.entityId ||
      original.asset.type !== target.asset.type ||
      original.run.promptVersion !== target.run.promptVersion ||
      !original.file.crc64 ||
      original.file.crc64 !== target.file.crc64 ||
      original.file.sizeBytes !== target.file.sizeBytes ||
      (original.file.sha256 && target.file.sha256 && original.file.sha256 !== target.file.sha256) ||
      privateFacts.sourceHash !== original.hash ||
      !same(privateFacts.frameAtMs, original.frameAtMs) ||
      !same(original.frameAtMs, target.frameAtMs)
    )
      continue;
    return {
      id: row.id,
      content,
      hash: hash([
        original.hash,
        original.run,
        row.id,
        row.content,
        row.provider,
        origin.provider,
        origin.input,
        origin.output,
      ]),
    };
  }
  return null;
}

const outdated = new Error("视觉任务已过期");
const resultHash = (target: { hash: string }, cache: { hash: string } | null) =>
  cache ? hash([target.hash, cache.hash]) : target.hash;

/** 准入/签发/模型失败不进入通用自动重试；只有完成事务写公开五项事实。 */
export function createAssetVisionStrategy(
  deps: AssetDeps,
  current: (tx: Tx, job: MediaJob) => Promise<boolean>,
) {
  async function admitted(job: MediaJob, model = false, expiresAt?: Date, signal?: AbortSignal) {
    if (job.kind !== "vision" || job.state !== "running" || !assetJobOwned(job)) return null;
    return deps.tx.run(async (tx) => {
      const input = AssetJobInputSchema.parse(job.input);
      await lockVisionParents(tx, input.assetId);
      await lockRows(tx, "media_job", [job.id]);
      const fresh = await tx.mediaJob.findUnique({ where: { id: job.id } });
      if (
        !fresh ||
        fresh.kind !== "vision" ||
        fresh.state !== "running" ||
        fresh.provider !== deps.assets.llm.status ||
        fresh.provider !== job.provider ||
        fresh.attemptNo !== job.attemptNo ||
        !job.leaseOwner ||
        fresh.leaseOwner !== job.leaseOwner ||
        !same(fresh.input, job.input)
      )
        return null;
      await lockVisionFiles(tx, fresh);
      if (!(await current(tx, fresh))) return null;
      const target = await source(deps, tx, fresh);
      const cache = target && !model ? await cached(deps, tx, target) : null;
      const expired = () => {
        const now = deps.clock.now();
        return fresh.nextRunAt <= now || fresh.deadlineAt <= now || (expiresAt && expiresAt <= now);
      };
      if (expired()) return null;
      if (!target) return { unavailable: true as const };
      const permitted =
        !model ||
        !!(await deps.assets.allowModelCall?.(tx, {
          storeId: target.asset.storeId,
          now: deps.clock.now(),
        }));
      // 准入也可能await；抛出令本Tx内预算写回滚，外层转为取消而非再次收费。
      if (expired() || signal?.aborted) throw outdated;
      return { target, cache, permitted };
    });
  }
  return {
    async execute(job: MediaJob, signal: AbortSignal): Promise<JobOutcome> {
      if (signal.aborted) return { state: "canceled" };
      try {
        const before = await admitted(job);
        if (!before || signal.aborted) return { state: "canceled" };
        if ("unavailable" in before) return skipped("vision_source_missing");
        const { target, cache } = before;
        const success = (content: NonNullable<ReturnType<typeof visionContent>>): JobOutcome => ({
          state: "succeeded",
          output: {
            status: "ok",
            reason: null,
            verdict: null,
            content: {
              ...content,
              sourceHash: resultHash(target, cache),
              frameAtMs: target.frameAtMs,
              cacheSourceId: cache?.id ?? null,
            },
            ...(cache ? { reusedFromId: cache.id } : {}),
          },
        });
        if (cache) return success(cache.content);
        if (!deps.assets.allowModelCall) return skipped("budget_unconfigured");
        if (deps.assets.llm.status === "unconfigured") return skipped("llm_unconfigured");
        assertNotInTransaction("素材视觉处理签发");
        const imageUrls: string[] = [];
        let expiresAt: Date | undefined;
        for (const atMs of target.asset.type === "image" ? [null] : target.frameAtMs) {
          if (signal.aborted) return { state: "canceled" };
          const signed = await deps.storage.presignVisionGet({
            bucket: "asset",
            key: target.file.objectKey,
            expiresSec: 900,
            source: atMs === null ? { kind: "image" } : { kind: "video-frame", atMs },
          });
          if (signal.aborted) return { state: "canceled" };
          if (!signed.ok) return skipped("vision_signing_unavailable");
          const url = new URL(signed.value.url);
          if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.hash ||
            Buffer.byteLength(signed.value.url) > 8192 ||
            Array.from(signed.value.url).some(
              (c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127 || c === "#",
            ) ||
            !Number.isFinite(signed.value.expiresAt.getTime()) ||
            signed.value.expiresAt <= deps.clock.now()
          )
            return skipped("vision_signing_unavailable");
          imageUrls.push(signed.value.url);
          if (!expiresAt || signed.value.expiresAt < expiresAt) expiresAt = signed.value.expiresAt;
        }
        const ready = await admitted(job, true, expiresAt, signal);
        if (!ready || signal.aborted) return { state: "canceled" };
        if ("unavailable" in ready || ready.target.hash !== target.hash)
          return { state: "canceled" };
        if (!ready.permitted) return skipped("budget_unconfigured");
        assertNotInTransaction("素材视觉模型调用");
        const result = await deps.assets.llm.analyzeVision({ imageUrls, signal });
        const after = await admitted(job);
        if (!after || "unavailable" in after || signal.aborted || after.target.hash !== target.hash)
          return { state: "canceled" };
        if (!result.ok) return skipped("vision_unavailable");
        const content = LlmVisionSchema.safeParse(result.value).data;
        return content ? success(content) : skipped("vision_result_invalid");
      } catch (error) {
        return signal.aborted || error === outdated
          ? { state: "canceled" }
          : skipped("vision_unavailable");
      }
    },
    async matches(tx: Tx, job: MediaJob, content: Readonly<Record<string, JobJson>>) {
      const facts = completion.safeParse(content).data;
      if (!facts || job.state !== "succeeded") return false;
      const output = AssetJobOutputSchema.safeParse(job.output).data;
      if (
        !output ||
        output.status !== "ok" ||
        !same(output.content, content) ||
        (output.reusedFromId ?? null) !== facts.cacheSourceId
      )
        return false;
      const target = await source(deps, tx, job);
      const cache =
        target && facts.cacheSourceId ? await cached(deps, tx, target, facts.cacheSourceId) : null;
      const now = deps.clock.now();
      return (
        !!target &&
        (!facts.cacheSourceId || !!cache) &&
        job.deadlineAt > now &&
        job.nextRunAt > now &&
        facts.sourceHash === resultHash(target, cache) &&
        same(facts.frameAtMs, target.frameAtMs)
      );
    },
  };
}
