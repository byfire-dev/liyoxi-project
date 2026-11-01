import { AppError, lockRows } from "../../kernel/index.js";
import type { Clock, Tx } from "../../kernel/index.js";
import type { DeliveryProductionPreparation } from "./prepare.js";
export interface AdProductionInput {
  fileId: string;
  adId: string;
  entityId: string;
  storeId: string;
  uploadedByStaffId: string;
  aiUsage?: { used: boolean; tools: readonly { name: string; version: string; usedFor: string }[] };
}
/** Registered-upload hook: only an immutable manual declaration, never a probe or ready result. */
export async function declareAdProduction(tx: Tx, clock: Clock, input: AdProductionInput) {
  const existing = await tx.productionRecord.findUnique({ where: { fileId: input.fileId } });
  if (existing) {
    if (
      existing.kind !== "ad" ||
      existing.adId !== input.adId ||
      existing.orderItemId !== null ||
      existing.variant !== "common" ||
      existing.uploadedByStaffId !== input.uploadedByStaffId
    )
      throw new AppError("FILE_NOT_USABLE", {
        details: { fileIds: [input.fileId], reason: "context_mismatch" },
      });
    return;
  }
  const file = await tx.fileObject.findUnique({ where: { id: input.fileId } });
  if (
    !file ||
    !["pending", "stored"].includes(file.status) ||
    file.category !== "ad_video" ||
    file.scopeType !== "store" ||
    file.entityId !== input.entityId ||
    file.storeId !== input.storeId ||
    file.uploadActorType !== "staff" ||
    file.uploadActorId !== input.uploadedByStaffId ||
    file.uploadClient !== "admin" ||
    file.moderationState === "block" ||
    file.deletedAt ||
    file.erasedAt
  )
    throw new AppError("FILE_NOT_USABLE", {
      details: { fileIds: [input.fileId], reason: "scope_mismatch" },
    });
  const now = clock.now(),
    ai = input.aiUsage ?? { used: false, tools: [] };
  await tx.productionRecord.create({
    data: {
      fileId: input.fileId,
      kind: "ad",
      adId: input.adId,
      variant: "common",
      source: "manual_upload",
      aiUsage: {
        used: ai.used,
        tools: ai.tools.map((t) => ({ ...t })),
        declaredBy: input.uploadedByStaffId,
        declaredAt: now.toISOString(),
        forcedByDrama: false,
      },
      aigcState: ai.used ? "pending" : "not_required",
      pipelineState: "uploading",
      uploadedByStaffId: input.uploadedByStaffId,
      createdAt: now,
      updatedAt: now,
    },
  });
}
/** The ad owner authorizes the parent. This media leaf creates a declaration and queues a real probe. */
export async function prepareAdProduction(
  tx: Tx,
  deps: DeliveryProductionPreparation,
  input: AdProductionInput,
) {
  const existing = await tx.productionRecord.findUnique({ where: { fileId: input.fileId } });
  if (existing) await lockRows(tx, "production_record", [input.fileId]);
  await lockRows(tx, "file_object", [input.fileId]);
  const file = await tx.fileObject.findUnique({ where: { id: input.fileId } });
  const unusable = (reason: string) =>
    new AppError("FILE_NOT_USABLE", { details: { fileIds: [input.fileId], reason } });
  if (!file || file.status !== "stored") throw unusable("not_stored");
  if (file.category !== "ad_video") throw unusable("category_mismatch");
  if (
    file.scopeType !== "store" ||
    file.entityId !== input.entityId ||
    file.storeId !== input.storeId
  )
    throw unusable("scope_mismatch");
  if (file.moderationState === "block" || file.deletedAt || file.erasedAt)
    throw unusable("blocked");
  if (
    existing &&
    (existing.kind !== "ad" ||
      existing.adId !== input.adId ||
      existing.orderItemId !== null ||
      existing.variant !== "common")
  )
    throw unusable("context_mismatch");
  if (!existing) await declareAdProduction(tx, deps.clock, input);
  if (!existing || ["uploading", "checking"].includes(existing.pipelineState))
    await deps.enqueueProbe(tx, input.fileId);
  return { fileId: input.fileId };
}
