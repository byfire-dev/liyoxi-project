import { AppError, lockRows } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { DeliveryProductionPreparation } from "./prepare.js";
export interface AdProductionInput {
  fileId: string;
  adId: string;
  entityId: string;
  storeId: string;
  uploadedByStaffId: string;
  aiUsage?: { used: boolean; tools: readonly { name: string; version: string; usedFor: string }[] };
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
  if (!existing) {
    const now = deps.clock.now(),
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
  if (!existing || ["uploading", "checking"].includes(existing.pipelineState))
    await deps.enqueueProbe(tx, input.fileId);
  return { fileId: input.fileId };
}
