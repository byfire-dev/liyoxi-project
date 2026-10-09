import { AppError, lockRows } from "../../kernel/index.js";
import type { Clock, Tx } from "../../kernel/index.js";

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
  readonly masterSource?: "checkout" | "declared" | "current_fallback";
  readonly headAdVersionId?: string | null;
  readonly tailAdVersionId?: string | null;
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
      masterSource: input.dramaEpisodeMasterId ? (input.masterSource ?? "declared") : null,
      headAdVersionId: input.headAdVersionId ?? null,
      tailAdVersionId: input.tailAdVersionId ?? null,
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

export interface DeliveryProductionPreparation {
  readonly clock: Clock;
  readonly enqueueProbe: (tx: Tx, fileId: string) => Promise<string>;
  readonly awaitingRestamp: (tx: Tx, fileId: string) => Promise<boolean>;
}
/** Caller holds the delivery parent locks. This function never produces technical conclusions. */
export async function prepareDeliveryProduction(
  tx: Tx,
  deps: DeliveryProductionPreparation,
  inputs: readonly ManualProductionInput[],
  beforeFiles?: () => Promise<void>,
) {
  const ids = [...new Set(inputs.map((input) => input.fileId))].sort();
  if (ids.length !== inputs.length) throw unusable(inputs[0]!.fileId, "duplicate");
  const existing = await tx.productionRecord.findMany({ where: { fileId: { in: ids } } });
  await lockRows(
    tx,
    "production_record",
    existing.map((record) => record.fileId),
  );
  await beforeFiles?.();
  await lockRows(tx, "file_object", ids);
  const result = [];
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
    }
    if (
      record.kind !== input.kind ||
      record.orderItemId !== input.orderItemId ||
      record.episodeNo !== input.episodeNo ||
      record.variant !== "common"
    )
      throw unusable(input.fileId, "context_mismatch");
    if (record.pipelineState === "rejected" && !(await deps.awaitingRestamp(tx, input.fileId)))
      throw new AppError("PRODUCTION_NOT_READY", {
        details: { fileId: input.fileId, pipelineState: record.pipelineState, gate: "reject" },
      });
    if (["uploading", "checking"].includes(record.pipelineState))
      await deps.enqueueProbe(tx, input.fileId);
    result.push({ file, record });
  }
  return result;
}
