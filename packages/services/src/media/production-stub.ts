// M1 同步桩：入库体检、水印与 AI 标识由 M3 接管；不覆盖真实制作结论。
import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { Clock, Tx } from "../kernel/index.js";
import type { Media } from "./runtime.js";

export interface ManualProductionInput {
  readonly fileId: string;
  readonly kind: "sample" | "final";
  readonly orderItemId: string;
  readonly episodeNo: number;
  readonly entityId: string;
  readonly storeId: string;
  readonly productionTier: string;
  readonly uploadedByStaffId: string;
  /** 由父域读取真实所属剧目，不能直接透传客户端字段。 */
  readonly forcedByDrama: boolean;
  readonly dramaEpisodeMasterId?: string;
  readonly aiUsage?: {
    readonly used: boolean;
    readonly tools: readonly { name: string; version: string; usedFor: string }[];
  };
}
const unusable = (id: string, reason: string) =>
  new AppError("FILE_NOT_USABLE", { details: { fileIds: [id], reason } });

/** 分类 registered 回调在新文件 INSERT 后调用；只创建声明，不覆盖旧上下文。 */
export async function declareManualProduction(tx: Tx, clock: Clock, input: ManualProductionInput) {
  const old = await tx.productionRecord.findUnique({ where: { fileId: input.fileId } });
  if (old) {
    if (
      old.kind !== input.kind ||
      old.orderItemId !== input.orderItemId ||
      old.episodeNo !== input.episodeNo ||
      old.variant !== "common"
    )
      throw unusable(input.fileId, "context_mismatch");
    return;
  }
  const now = clock.now(),
    ai = input.aiUsage ?? { used: false, tools: [] },
    used = ai.used || input.forcedByDrama;
  await tx.productionRecord.create({
    data: {
      fileId: input.fileId,
      kind: input.kind,
      orderItemId: input.orderItemId,
      episodeNo: input.episodeNo,
      variant: "common",
      source: "manual_upload",
      productionTier: input.productionTier,
      dramaEpisodeMasterId: input.dramaEpisodeMasterId ?? null,
      masterSource: input.dramaEpisodeMasterId ? "declared" : null,
      aiUsage: {
        used,
        tools: ai.tools.map((t) => ({ ...t })),
        declaredBy: input.uploadedByStaffId,
        declaredAt: now.toISOString(),
        forcedByDrama: input.forcedByDrama,
      },
      aigcState: used ? "pending" : "not_required",
      pipelineState: "uploading",
      uploadedByStaffId: input.uploadedByStaffId,
      createdAt: now,
      updatedAt: now,
    },
  });
}

/** 调用者先持父锁；多文件统一预锁，不能逐文件回退到较早的媒体锁。 */
export async function ensureProductionStubs(
  tx: Tx,
  deps: { clock: Clock; media: Pick<Media, "link"> },
  inputs: readonly ManualProductionInput[],
  beforeFiles?: () => Promise<void>,
) {
  const ids = [...new Set(inputs.map((i) => i.fileId))].sort();
  if (ids.length !== inputs.length) throw unusable(inputs[0]!.fileId, "duplicate");
  const existingPlayable = await tx.playableAsset.findMany({
    where: {
      kind: "sample",
      sourceFileId: { in: inputs.filter((i) => i.kind === "sample").map((i) => i.fileId) },
      specVersion: 1,
    },
  });
  await lockRows(
    tx,
    "playable_asset",
    existingPlayable.map((p) => p.id),
  );
  const before = await tx.productionRecord.findMany({ where: { fileId: { in: ids } } });
  await lockRows(
    tx,
    "production_record",
    before.map((p) => p.fileId),
  );
  await beforeFiles?.();
  await lockRows(tx, "file_object", ids);
  const now = deps.clock.now(),
    result = [];
  for (const input of inputs) {
    const file = await tx.fileObject.findUnique({ where: { id: input.fileId } });
    if (!file || file.status !== "stored") throw unusable(input.fileId, "not_stored");
    if (
      file.entityId !== input.entityId ||
      file.storeId !== input.storeId ||
      file.scopeType !== "store"
    )
      throw unusable(input.fileId, "scope_mismatch");
    if (file.category !== (input.kind === "sample" ? "sample_video" : "final_episode"))
      throw unusable(input.fileId, "category_mismatch");
    if (file.moderationState === "block") throw unusable(input.fileId, "blocked");
    let record = await tx.productionRecord.findUnique({ where: { fileId: input.fileId } });
    if (!record) {
      await declareManualProduction(tx, deps.clock, input);
      record = await tx.productionRecord.findUniqueOrThrow({ where: { fileId: input.fileId } });
      if (record.aigcState === "not_required")
        record = await tx.productionRecord.update({
          where: { fileId: input.fileId },
          data: { pipelineState: "ready", updatedAt: now },
        });
    } else {
      if (
        record.kind !== input.kind ||
        record.orderItemId !== input.orderItemId ||
        record.episodeNo !== input.episodeNo ||
        record.variant !== "common"
      )
        throw unusable(input.fileId, "context_mismatch");
      if (record.pipelineState === "rejected")
        throw new AppError("PRODUCTION_NOT_READY", {
          details: { fileId: file.id, pipelineState: record.pipelineState, gate: "reject" },
        });
      const ai = record.aiUsage as { used?: boolean };
      // 已上传的人工、未用 AI 声明可以用同步桩完成；真实派生或 AI 标识事实保持原样。
      if (
        !input.forcedByDrama &&
        record.source === "manual_upload" &&
        ai.used === false &&
        record.aigcState === "not_required" &&
        ["uploading", "checking"].includes(record.pipelineState)
      ) {
        if (!before.some((p) => p.fileId === record!.fileId)) throw new AppError("BUSY");
        record = await tx.productionRecord.update({
          where: { fileId: file.id },
          data: {
            pipelineState: "ready",
            updatedAt: now,
          },
        });
      }
    }
    let playable =
      input.kind === "sample"
        ? await tx.playableAsset.findUnique({
            where: {
              kind_sourceFileId_specVersion: {
                kind: "sample",
                sourceFileId: file.id,
                specVersion: 1,
              },
            },
          })
        : null;
    if (
      playable &&
      (playable.entityId !== input.entityId ||
        playable.storeId !== input.storeId ||
        playable.ownerType !== "order_item" ||
        playable.ownerId !== input.orderItemId)
    )
      throw unusable(file.id, "context_mismatch");
    if (
      input.kind === "sample" &&
      !input.forcedByDrama &&
      !playable &&
      record.pipelineState === "ready" &&
      record.aigcState === "not_required" &&
      (record.aiUsage as { used?: boolean }).used === false
    ) {
      const info = await tx.mediaInfo.findUnique({ where: { fileId: file.id } });
      playable = await tx.playableAsset.create({
        data: {
          id: uuidv7(),
          entityId: input.entityId,
          storeId: input.storeId,
          kind: "sample",
          sourceFileId: file.id,
          ownerType: "order_item",
          ownerId: input.orderItemId,
          state: "ready",
          durationMs: info?.durationMs ?? null,
          width: info?.width ?? null,
          height: info?.height ?? null,
          renditions: [
            {
              quality: "source",
              fileId: file.id,
              width: info?.width ?? null,
              height: info?.height ?? null,
              bitrateKbps: null,
            },
          ],
          specVersion: 1,
          readyAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
      for (const role of ["source", "rendition"])
        await deps.media.link(tx, {
          fileId: file.id,
          entityId: input.entityId,
          storeId: input.storeId,
          refType: "playable_asset",
          refId: playable.id,
          role,
        });
    }
    result.push({ file, record, playable });
  }
  return result;
}

export const mediaDeliveryRefTypes = {
  upload_batch: {
    roles: { main: { categories: ["final_episode", "drama_master"] as const, retentionDays: 0 } },
    readColumns: async (tx: Tx) =>
      (
        await tx.uploadBatchItem.findMany({
          where: {
            file: { status: "stored" },
            state: { notIn: ["skipped", "replaced"] },
          },
        })
      ).map((i) => ({ fileId: i.fileId, refId: i.uploadBatchId, role: "main" })),
  },
  playable_asset: {
    roles: {
      source: {
        categories: ["sample_video", "ad_video", "trailer_src"] as const,
        retentionDays: 30,
      },
      rendition: {
        categories: ["sample_video", "sample_wm", "ad_video", "trailer_out"] as const,
        retentionDays: 30,
      },
      cover: { categories: ["video_cover", "poster"] as const, retentionDays: 30 },
    },
    readColumns: async (tx: Tx) =>
      (await tx.playableAsset.findMany()).flatMap((p) => [
        { fileId: p.sourceFileId, refId: p.id, role: "source" },
        ...((p.renditions ?? []) as Array<{ fileId: string }>).map((r) => ({
          fileId: r.fileId,
          refId: p.id,
          role: "rendition",
        })),
        ...(p.coverFileId ? [{ fileId: p.coverFileId, refId: p.id, role: "cover" }] : []),
      ]),
  },
};
