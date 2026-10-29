import { Prisma } from "@liyoxi/db";
import type { UploadBatch, UploadBatchItem } from "@liyoxi/db";
import { UploadBatchDetailSchema, UploadBatchItemSchema } from "@liyoxi/contract";
import {
  extensionOf,
  maxUploadBytes,
  UPLOAD_CATEGORIES,
  MIME_BY_EXT,
} from "@liyoxi/shared/uploads";
import type { UploadCategory } from "@liyoxi/shared/uploads";
import { AppError, lockRows, uuidv7 } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { BoundMediaDeps, BatchRuntimeDeps, MediaActor } from "../context.js";
import { batchCoverage, activeExpiry, decideBatchState } from "./state.js";

export const prefixOf = (batchId: string) => `incoming/b${batchId}/`;
export const categoryOfBatch = (purpose: string): UploadCategory =>
  purpose === "drama_master" ? "drama_master" : "final_episode";
export function batchDeps(deps: BoundMediaDeps): BatchRuntimeDeps {
  if (!deps.batches) throw new AppError("PROVIDER_UNAVAILABLE");
  return deps as BatchRuntimeDeps;
}
export function staffOf(actor: MediaActor) {
  if (
    !actor.staff ||
    actor.identity.actor.type !== "staff" ||
    actor.identity.actor.id !== actor.staff.staff.id
  )
    throw new AppError("PERMISSION_DENIED");
  return actor.staff;
}
export async function batchOf(tx: Tx, id: string) {
  const row = await tx.uploadBatch.findUnique({
    where: { id },
    include: { uploadBatchItems: true },
  });
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}
export async function ownedBatch(
  tx: Tx,
  deps: BatchRuntimeDeps,
  actor: MediaActor,
  id: string,
  options: { lockTarget?: boolean; allowEnded?: boolean } = {},
) {
  const staff = staffOf(actor),
    before = await batchOf(tx, id);
  if (before.createdByStaffId !== staff.staff.id) throw new AppError("NOT_FOUND");
  const facts = await deps.batches.authorizeTarget(tx, staff, {
    purpose: before.purpose,
    targetId: before.targetId,
    lock: options.lockTarget === true,
    readOnly: false,
  });
  const batch = await batchOf(tx, id);
  if (
    !options.allowEnded &&
    (batch.expiresAt <= deps.clock.now() ||
      ["committed", "canceled", "expired"].includes(batch.state))
  )
    throw new AppError("STATE_NOT_ALLOWED");
  return { batch, facts, staff };
}
export async function lockBatchRecords(tx: Tx, batchId: string) {
  const files = await tx.fileObject.findMany({
    where: { uploadBatchId: batchId },
    select: { id: true },
  });
  const sampleQuery = {
    where: { kind: "sample", sourceFileId: { in: files.map((file) => file.id) } },
    select: { id: true },
  };
  const samples = await tx.playableAsset.findMany(sampleQuery);
  const lockedSamples = new Set(samples.map((sample) => sample.id));
  await lockRows(tx, "playable_asset", [...lockedSamples]);
  const records = await tx.productionRecord.findMany({
    where: { file: { uploadBatchId: batchId } },
    select: { fileId: true },
  });
  const locked = new Set(records.map((r) => r.fileId));
  await lockRows(tx, "production_record", [...locked]);
  await lockRows(tx, "upload_batch", [batchId]);
  const current = await tx.productionRecord.findMany({
    where: { file: { uploadBatchId: batchId } },
    select: { fileId: true },
  });
  if (current.some((r) => !locked.has(r.fileId))) throw new AppError("BUSY");
  const currentFiles = await tx.fileObject.findMany({
    where: { uploadBatchId: batchId },
    select: { id: true },
  });
  const currentSamples = await tx.playableAsset.findMany({
    where: { kind: "sample", sourceFileId: { in: currentFiles.map((file) => file.id) } },
    select: { id: true },
  });
  if (currentSamples.some((sample) => !lockedSamples.has(sample.id))) throw new AppError("BUSY");
}
/** Call only after holding the batch; all existing files are locked once in UUID order. */
export async function lockBatchFiles(tx: Tx, batchId: string) {
  const files = await tx.fileObject.findMany({
    where: { uploadBatchId: batchId },
    select: { id: true },
  });
  await lockRows(
    tx,
    "file_object",
    files.map((file) => file.id),
  );
}
export function validateBatchFiles(
  purpose: string,
  files: readonly { clientToken: string; originalName: string; sizeBytes: string }[],
  expectedCount: number,
) {
  const category = categoryOfBatch(purpose),
    allowed = UPLOAD_CATEGORIES[category],
    names = new Set<string>(),
    tokens = new Set<string>();
  const errors: { index: number; reason: string }[] = [];
  for (const [index, f] of files.entries()) {
    const ext = extensionOf(f.originalName);
    const size = BigInt(f.sizeBytes);
    if (!ext || !allowed.exts.includes(ext) || ext === "zip")
      errors.push({ index, reason: "extension" });
    else if (size <= 0n || size > maxUploadBytes(category, ext, "admin", 200))
      errors.push({ index, reason: "size" });
    if (names.has(f.originalName)) errors.push({ index, reason: "duplicate_name" });
    if (tokens.has(f.clientToken)) errors.push({ index, reason: "duplicate_token" });
    names.add(f.originalName);
    tokens.add(f.clientToken);
  }
  if (files.length > expectedCount) errors.push({ index: expectedCount, reason: "too_many" });
  if (errors.length) throw new AppError("BATCH_FILE_INVALID", { details: { files: errors } });
}
export async function createBatchFile(
  tx: Tx,
  deps: BatchRuntimeDeps,
  batch: UploadBatch,
  scope: { entityId: string | null; storeId: string | null },
  input: { originalName: string; clientToken: string; sizeBytes: string },
) {
  const id = uuidv7(),
    ext = extensionOf(input.originalName)!,
    category = categoryOfBatch(batch.purpose),
    definition = UPLOAD_CATEGORIES[category],
    now = deps.clock.now();
  return tx.fileObject.create({
    data: {
      id,
      bucket: definition.bucket,
      objectKey: `${category}/${scope.storeId ?? "platform"}/${id}.${ext}`,
      incomingBucket: definition.bucket === "pub" ? "asset" : definition.bucket,
      incomingKey: `${prefixOf(batch.id)}${id}.${ext}`,
      category,
      scopeType: scope.storeId ? "store" : "platform",
      entityId: scope.entityId,
      storeId: scope.storeId,
      uploadActorType: "staff",
      uploadActorId: batch.createdByStaffId,
      uploadClient: "admin",
      status: "pending",
      uploadMode: deps.storage.capabilities.sts ? "multipart" : "post",
      clientToken: input.clientToken,
      uploadBatchId: batch.id,
      declaredSize: BigInt(input.sizeBytes),
      declaredMime: MIME_BY_EXT[ext]!,
      ext,
      originalName: input.originalName,
      uploadExpiresAt: batch.expiresAt,
      createdAt: now,
      updatedAt: now,
    },
  });
}
const plain = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export async function itemView(
  tx: Tx,
  item: UploadBatchItem,
  facts?: {
    episodes: readonly { episodeNo: number; title: string | null }[];
    masters: readonly { episodeNo: number; durationMs: number | null }[];
  },
) {
  const file = await tx.fileObject.findUniqueOrThrow({
    where: { id: item.fileId },
    include: { mediaInfo: true },
  });
  const report = await tx.mediaCheck.findUnique({ where: { fileId: file.id } });
  const previous = facts?.masters.find((m) => m.episodeNo === item.episodeNo)?.durationMs ?? null;
  const hard = Array.isArray(report?.hard)
    ? report.hard
    : Object.entries(plain(report?.hard)).map(([code, value]) => ({
        code,
        ...plain(value),
      }));
  const soft = Array.isArray(report?.soft)
    ? report.soft
    : Object.entries(plain(report?.soft)).map(([code, value]) => ({
        code,
        ...plain(value),
      }));
  const check = report
    ? {
        gate: report.gate,
        failedHard: hard
          .map(plain)
          .filter((r) => r.pass === false || r.result === "fail")
          .map((r) => ({
            code: r.code,
            actual:
              typeof r.actual === "string" || typeof r.actual === "number"
                ? r.actual
                : String(r.actual),
            expected:
              typeof r.expected === "string" || typeof r.expected === "number"
                ? r.expected
                : String(r.expected),
          })),
        warnings: soft
          .map(plain)
          .filter(
            (r) =>
              r.warn === true ||
              r.pass === false ||
              r.result === "warn" ||
              r.level === "warn" ||
              r.level === "info",
          )
          .map((r) => ({ code: r.code, note: String(r.note ?? "") })),
      }
    : null;
  return UploadBatchItemSchema.parse({
    uploadBatchItemId: item.id,
    fileId: file.id,
    originalName: item.originalName,
    sizeBytes: file.declaredSize.toString(),
    uploadKey: file.incomingKey,
    fileStatus: file.status,
    rejectReason: file.rejectReason,
    episodeNo: item.episodeNo,
    episodeTitle: facts?.episodes.find((e) => e.episodeNo === item.episodeNo)?.title ?? null,
    matchMethod: item.matchMethod,
    state: item.state,
    durationMs: file.mediaInfo?.durationMs ?? null,
    previousDurationMs: previous,
    isDurationDiffWarn:
      previous !== null &&
      file.mediaInfo?.durationMs !== null &&
      file.mediaInfo?.durationMs !== undefined &&
      Math.abs(previous - file.mediaInfo.durationMs) > 2000,
    check,
    aiUsage: item.aiUsage,
    updatedAt: item.updatedAt.toISOString(),
  });
}
export async function batchView(tx: Tx, deps: BatchRuntimeDeps, actor: MediaActor, id: string) {
  const batch = await batchOf(tx, id),
    facts = await deps.batches.readTarget(tx, batch),
    location = deps.storage.uploadLocation;
  if (!location) throw new AppError("PROVIDER_UNAVAILABLE");
  const definition = UPLOAD_CATEGORIES[categoryOfBatch(batch.purpose)],
    bucket = definition.bucket === "pub" ? "asset" : definition.bucket;
  const items = [...batch.uploadBatchItems].sort(
    (a, b) =>
      (a.episodeNo ?? Number.MAX_SAFE_INTEGER) - (b.episodeNo ?? Number.MAX_SAFE_INTEGER) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  let writable =
    batch.createdByStaffId === staffOf(actor).staff.id && batch.expiresAt > deps.clock.now();
  if (writable)
    try {
      await deps.batches.authorizeTarget(tx, staffOf(actor), {
        purpose: batch.purpose,
        targetId: batch.targetId,
        lock: false,
        readOnly: false,
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      writable = false;
    }
  const actions: string[] = [];
  if (writable) {
    if (batch.state === "matching") actions.push("start");
    if (batch.state === "uploading") actions.push("refresh-credentials");
    if (batch.state === "ready" && batch.purpose === "drama_master") actions.push("commit");
    if (["matching", "ready"].includes(batch.state)) actions.push("cancel");
  }
  const staff = await deps.batches.readStaffBrief(tx, batch.createdByStaffId);
  if (!staff) throw new AppError("NOT_FOUND");
  const states = ["pending", "uploaded", "checked", "rejected", "skipped", "replaced"];
  const counts = Object.fromEntries(
    states.map((state) => [state, items.filter((i) => i.state === state).length]),
  );
  return UploadBatchDetailSchema.parse({
    uploadBatchId: batch.id,
    purpose: batch.purpose,
    targetId: batch.targetId,
    targetLabel: facts.targetLabel,
    variant: batch.variant,
    scope: batch.scope,
    state: batch.state,
    expectedCount: batch.expectedCount,
    replaceReason: batch.replaceReason,
    isContentChanged: batch.isContentChanged,
    aiUsage: batch.aiUsage,
    note: batch.note,
    bucket: location.buckets[bucket],
    region: location.region,
    prefix: prefixOf(batch.id),
    expiresAt: batch.expiresAt.toISOString(),
    committedAt: batch.committedAt?.toISOString() ?? null,
    createdBy: staff,
    createdAt: batch.createdAt.toISOString(),
    updatedAt: batch.updatedAt.toISOString(),
    counts: { total: items.length, ...counts },
    coverage: batchCoverage(items, batch.expectedCount, batch.scope, batch.state === "matching"),
    items: await Promise.all(
      items.map((i) => itemView(tx, i, batch.purpose === "drama_master" ? facts : undefined)),
    ),
    actions,
  });
}
export async function convergeBatch(tx: Tx, deps: Pick<BatchRuntimeDeps, "clock">, id: string) {
  const batch = await batchOf(tx, id),
    state = decideBatchState(batch, batch.uploadBatchItems),
    now = deps.clock.now();
  if (state !== batch.state)
    await tx.uploadBatch.update({ where: { id }, data: { state, updatedAt: now } });
}
export const jsonInput = (value: unknown) =>
  value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
export const touch = (batch: UploadBatch, now: Date) => ({
  expiresAt: activeExpiry(batch.createdAt, now),
  updatedAt: now,
});
/** The caller holds batch380 and every batch file410; pending expiry follows the batch. */
export async function touchBatch(tx: Tx, batch: UploadBatch, now: Date) {
  const activity = touch(batch, now);
  await tx.fileObject.updateMany({
    where: { uploadBatchId: batch.id, status: "pending" },
    data: { uploadExpiresAt: activity.expiresAt, updatedAt: now },
  });
  await tx.uploadBatch.update({ where: { id: batch.id }, data: activity });
}
