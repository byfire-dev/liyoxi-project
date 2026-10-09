import type { FileObject, UploadBatchItem } from "@liyoxi/db";
import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { BoundMediaDeps } from "../context.js";
import { link, release } from "../refs.js";
import { batchOf, categoryOfBatch, convergeBatch } from "./helpers.js";

/** The job runner holds production360, batch380, job400 and every changed file410. */
async function activeFile(tx: Tx, batchId: string, fileId: string, now: Date) {
  const batch = await batchOf(tx, batchId);
  if (batch.expiresAt <= now || !["uploading", "verifying", "ready"].includes(batch.state))
    return null;
  const file = await tx.fileObject.findUnique({ where: { id: fileId } });
  if (
    !file ||
    file.uploadBatchId !== batch.id ||
    file.category !== categoryOfBatch(batch.purpose) ||
    file.moderationState === "block"
  )
    return null;
  const record = await tx.productionRecord.findUnique({ where: { fileId } });
  const item = batch.uploadBatchItems.find(
    (one) =>
      !["skipped", "replaced"].includes(one.state) &&
      (one.fileId === file.id || one.fileId === record?.derivedFromFileId),
  );
  if (!item) return null;
  if (batch.purpose === "final_release") {
    if (
      !record ||
      record.kind !== "final" ||
      record.orderItemId !== batch.targetId ||
      record.episodeNo !== item.episodeNo ||
      record.variant !== batch.variant
    )
      return null;
    if (item.fileId !== file.id) {
      const source = await tx.fileObject.findUnique({ where: { id: item.fileId } });
      const original = await tx.productionRecord.findUnique({ where: { fileId: item.fileId } });
      if (
        !source ||
        !original ||
        source.uploadBatchId !== batch.id ||
        source.category !== file.category ||
        source.entityId !== file.entityId ||
        source.storeId !== file.storeId ||
        original.orderItemId !== record.orderItemId ||
        original.episodeNo !== record.episodeNo ||
        original.variant !== record.variant ||
        original.productionTier !== record.productionTier ||
        original.dramaEpisodeMasterId !== record.dramaEpisodeMasterId ||
        original.masterSource !== record.masterSource ||
        original.headAdVersionId !== record.headAdVersionId ||
        original.tailAdVersionId !== record.tailAdVersionId ||
        JSON.stringify(original.aiUsage) !== JSON.stringify(record.aiUsage)
      )
        return null;
    }
  } else if (record || item.fileId !== file.id) return null;
  return { batch, file, item, record };
}

export function createBatchWorkerHooks(deps: BoundMediaDeps) {
  const settle = async (tx: Tx, batchId: string) => {
    await convergeBatch(tx, deps, batchId);
    await tx.uploadBatch.update({
      where: { id: batchId },
      data: { updatedAt: deps.clock.now() },
    });
  };
  const reference = (file: FileObject, batchId: string) => ({
    fileId: file.id,
    entityId: file.entityId,
    storeId: file.storeId,
    refType: "upload_batch",
    refId: batchId,
    role: "main",
  });
  return {
    needsJob: async (tx: Tx, input: { batchId: string; fileId: string }) =>
      (await activeFile(tx, input.batchId, input.fileId, deps.clock.now())) !== null,
    converge: async (tx: Tx, batchId: string) => {
      const batch = await batchOf(tx, batchId);
      if (batch.expiresAt > deps.clock.now()) await convergeBatch(tx, deps, batchId);
    },
    stored: async (tx: Tx, fileId: string) => {
      const file = await tx.fileObject.findUniqueOrThrow({ where: { id: fileId } });
      if (!file.uploadBatchId) return;
      const current = await activeFile(tx, file.uploadBatchId, fileId, deps.clock.now());
      if (!current || current.file.status !== "stored" || current.item.fileId !== fileId)
        throw new AppError("STATE_NOT_ALLOWED");
      await link(deps, tx, reference(file, current.batch.id));
      if (current.item.state === "pending")
        await tx.uploadBatchItem.update({
          where: { id: current.item.id },
          data: { state: "uploaded", updatedAt: deps.clock.now() },
        });
      if (current.record?.pipelineState === "uploading")
        await tx.productionRecord.update({
          where: { fileId },
          data: { pipelineState: "checking", updatedAt: deps.clock.now() },
        });
      await settle(tx, current.batch.id);
    },
    rejected: async (tx: Tx, fileId: string) => {
      const file = await tx.fileObject.findUniqueOrThrow({ where: { id: fileId } });
      if (!file.uploadBatchId) return;
      const current = await activeFile(tx, file.uploadBatchId, fileId, deps.clock.now());
      if (!current || current.item.fileId !== fileId || current.file.status !== "rejected") return;
      await tx.uploadBatchItem.update({
        where: { id: current.item.id },
        data: { state: "rejected", updatedAt: deps.clock.now() },
      });
      if (current.record)
        await tx.productionRecord.update({
          where: { fileId },
          data: { pipelineState: "rejected", updatedAt: deps.clock.now() },
        });
      await settle(tx, current.batch.id);
    },
    checked: async (
      tx: Tx,
      input: { fileId: string; gate: "pass" | "reject"; derivedFromFileId: string | null },
    ) => {
      const file = await tx.fileObject.findUniqueOrThrow({ where: { id: input.fileId } });
      if (!file.uploadBatchId) return;
      const current = await activeFile(tx, file.uploadBatchId, file.id, deps.clock.now());
      if (!current) return;
      const check = await tx.mediaCheck.findUnique({ where: { fileId: file.id } });
      if (
        current.file.status !== "stored" ||
        check?.gate !== input.gate ||
        (current.record?.derivedFromFileId ?? null) !== input.derivedFromFileId ||
        (input.gate === "pass" &&
          current.record &&
          (current.record.pipelineState !== "ready" ||
            !["not_required", "verified"].includes(current.record.aigcState)))
      )
        throw new AppError("STATE_NOT_ALLOWED");
      if (current.item.fileId !== file.id) {
        await link(deps, tx, reference(file, current.batch.id));
        await release(deps, tx, {
          ...reference({ ...file, id: current.item.fileId }, current.batch.id),
          keepUntil: new Date(deps.clock.now().getTime() + 3 * 86_400_000),
        });
      }
      const state: UploadBatchItem["state"] = input.gate === "pass" ? "checked" : "rejected";
      await tx.uploadBatchItem.update({
        where: { id: current.item.id },
        data: { fileId: file.id, state, updatedAt: deps.clock.now() },
      });
      await settle(tx, current.batch.id);
    },
  };
}
