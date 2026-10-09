import {
  BatchUploadCredentialsSchema,
  UploadBatchCreateBodySchema,
  UploadBatchItemUpdateBodySchema,
  UploadBatchStartBodySchema,
} from "@liyoxi/contract";
import type { UploadBatch } from "@liyoxi/db";
import { matchEpisodes } from "@liyoxi/shared";
import { AppError, createThreePhaseRunner, lockRows, uuidv7 } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { record } from "../../audit/index.js";
import type { BoundMediaDeps, MediaActor, MediaOptions } from "../context.js";
import { release } from "../refs.js";
import { matchesMagic } from "@liyoxi/shared/uploads";
import type { StorageBucket } from "../../providers/types.js";
import { emitFile, notifyPromote, providerValue } from "../upload.js";
import { activeExpiry, activeItems, batchCoverage, coverageComplete } from "./state.js";
import {
  batchDeps,
  batchOf,
  batchView,
  convergeBatch,
  createBatchFile,
  itemView,
  jsonInput,
  lockBatchRecords,
  lockBatchFiles,
  ownedBatch,
  prefixOf,
  staffOf,
  touchBatch,
  validateBatchFiles,
} from "./helpers.js";
import type { BatchRuntimeDeps } from "./types.js";

const parsed = <T>(result: { success: boolean; data?: T }): T => {
  if (!result.success) throw new AppError("VALIDATION_FAILED");
  return result.data!;
};
const empty = (raw: unknown) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.keys(raw).length)
    throw new AppError("VALIDATION_FAILED");
};
async function audit(
  tx: Tx,
  actor: MediaActor,
  batch: UploadBatch,
  action: string,
  summary: string,
) {
  const ctx = actor.identity;
  await record(
    tx,
    ctx.actor,
    actor.audit ?? {
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      authMethod: null,
      sessionId: null,
    },
    {
      stream: "activity",
      category: "flow",
      action: `media.batch.${action}`,
      summary,
      target: {
        type: batch.purpose === "drama_master" ? "drama" : "order_item",
        id: batch.targetId,
      },
    },
  );
}
async function createProduction(
  tx: Tx,
  deps: BatchRuntimeDeps,
  batch: UploadBatch,
  fileId: string,
  episodeNo: number | null,
) {
  if (batch.purpose !== "final_release") return;
  const ai = batch.aiUsage as { used: boolean },
    p = batch.productionCtx as {
      headAdVersionId: string | null;
      tailAdVersionId: string | null;
      productionTier: string;
    };
  const masterId =
      episodeNo === null ? null : await deps.batches.currentMaster(tx, batch, episodeNo),
    now = deps.clock.now();
  await tx.productionRecord.create({
    data: {
      fileId,
      kind: "final",
      orderItemId: batch.targetId,
      episodeNo,
      variant: "common",
      source: "manual_upload",
      productionTier: p.productionTier,
      dramaEpisodeMasterId: masterId,
      masterSource: masterId ? "current_fallback" : null,
      headAdVersionId: p.headAdVersionId,
      tailAdVersionId: p.tailAdVersionId,
      aiUsage: jsonInput(batch.aiUsage),
      aigcState: ai.used ? "pending" : "not_required",
      pipelineState: "uploading",
      uploadedByStaffId: batch.createdByStaffId,
      createdAt: now,
      updatedAt: now,
    },
  });
}

export function createUploadBatches(input: BoundMediaDeps) {
  const deps = batchDeps(input);
  const get = (actor: MediaActor, id: string) =>
    deps.tx.run(async (tx) => {
      const batch = await batchOf(tx, id),
        staff = staffOf(actor);
      if (batch.createdByStaffId !== staff.staff.id) {
        try {
          await deps.batches.authorizeTarget(tx, staff, {
            purpose: batch.purpose,
            targetId: batch.targetId,
            lock: false,
            readOnly: true,
          });
        } catch (error) {
          if (error instanceof AppError) throw new AppError("NOT_FOUND");
          throw error;
        }
      }
      return batchView(tx, deps, actor, id);
    });
  const create = (actor: MediaActor, raw: unknown, options: MediaOptions = {}) => {
    const body = parsed(UploadBatchCreateBodySchema.safeParse(raw)),
      staff = staffOf(actor);
    if (!options.idem?.key) throw new AppError("IDEMPOTENCY_KEY_REQUIRED");
    const key = options.idem.key;
    return deps.tx.run(async (tx) => {
      const facts = await deps.batches.authorizeTarget(tx, staff, {
        purpose: body.purpose,
        targetId: body.targetId,
        lock: true,
        readOnly: false,
      });
      if (!facts.expectedCount || !Number.isSafeInteger(facts.expectedCount))
        throw new AppError("TOTAL_EPISODES_MISSING");
      validateBatchFiles(body.purpose, body.files, facts.expectedCount);
      const existing = await tx.uploadBatch.findUnique({
        where: {
          createdByStaffId_idempotencyKey: {
            createdByStaffId: staff.staff.id,
            idempotencyKey: key,
          },
        },
      });
      if (existing) {
        if (existing.purpose !== body.purpose || existing.targetId !== body.targetId)
          throw new AppError("IDEMPOTENCY_KEY_REUSED");
        return batchView(tx, deps, actor, existing.id);
      }
      if (body.purpose === "drama_master" && facts.masters.length && !body.replaceReason)
        throw new AppError("VALIDATION_FAILED");
      const now = deps.clock.now(),
        id = uuidv7(),
        declaration = body.aiUsage
          ? {
              used: body.aiUsage.used || facts.forcedByDrama,
              tools: body.aiUsage.tools,
              declaredBy: staff.staff.id,
              declaredAt: now.toISOString(),
              forcedByDrama: facts.forcedByDrama,
            }
          : null;
      const batch = await tx.uploadBatch.create({
        data: {
          id,
          purpose: body.purpose,
          targetId: body.targetId,
          variant: "common",
          createdByStaffId: staff.staff.id,
          state: "matching",
          expectedCount: facts.expectedCount,
          scope: body.scope,
          replaceReason: body.replaceReason,
          isContentChanged: body.isContentChanged,
          aiUsage: jsonInput(declaration),
          productionCtx: jsonInput(facts.productionContext),
          note: body.note,
          idempotencyKey: key,
          expiresAt: activeExpiry(now, now),
          createdAt: now,
          updatedAt: now,
        },
      });
      const matches = matchEpisodes(
        body.files.map((f) => f.originalName),
        batch.expectedCount,
      );
      for (const [index, draft] of body.files.entries()) {
        const file = await createBatchFile(tx, deps, batch, facts, draft),
          match = matches[index]!;
        await tx.uploadBatchItem.create({
          data: {
            id: uuidv7(),
            uploadBatchId: id,
            fileId: file.id,
            originalName: draft.originalName,
            episodeNo: match.episodeNo,
            matchMethod: match.matchMethod,
            state: "pending",
            createdAt: now,
            updatedAt: now,
          },
        });
        await createProduction(tx, deps, batch, file.id, match.episodeNo);
      }
      await audit(tx, actor, batch, "create", `建立${body.files.length}个文件的上传批次`);
      return batchView(tx, deps, actor, id);
    }, options);
  };
  const start = (actor: MediaActor, id: string, raw: unknown, options: MediaOptions = {}) => {
    const body = parsed(UploadBatchStartBodySchema.safeParse(raw));
    return deps.tx.run(async (tx) => {
      await ownedBatch(tx, deps, actor, id, { lockTarget: true });
      await lockRows(tx, "upload_batch", [id]);
      const batch = await batchOf(tx, id);
      if (batch.state !== "matching") throw new AppError("STATE_NOT_ALLOWED");
      const coverage = batchCoverage(
        batch.uploadBatchItems,
        batch.expectedCount,
        batch.scope,
        !body.acceptSequenceSuggestion,
      );
      if (!activeItems(batch.uploadBatchItems).length || !coverageComplete(coverage))
        throw new AppError("BATCH_MATCH_INCOMPLETE", { details: coverage });
      await lockBatchFiles(tx, id);
      await touchBatch(tx, batch, deps.clock.now());
      await tx.uploadBatch.update({ where: { id }, data: { state: "uploading" } });
      await audit(tx, actor, batch, "start", "确认匹配并开始上传");
      return batchView(tx, deps, actor, id);
    }, options);
  };
  const refreshCredentials = async (actor: MediaActor, id: string, raw: unknown) => {
    empty(raw);
    await deps.tx.run(async (tx) => {
      const { batch } = await ownedBatch(tx, deps, actor, id);
      if (batch.state !== "uploading") throw new AppError("STATE_NOT_ALLOWED");
      return batch;
    });
    const bucket = "media" as const;
    const grant = providerValue(
      await deps.storage.issueSts({ bucket, keyPrefix: prefixOf(id), durationSec: 1800 }),
    );
    const location = deps.storage.uploadLocation;
    if (!location || grant.expiresAt <= deps.clock.now())
      throw new AppError("PROVIDER_UNAVAILABLE");
    await deps.tx.run(async (tx) => {
      const { batch } = await ownedBatch(tx, deps, actor, id);
      if (batch.state !== "uploading") throw new AppError("STATE_NOT_ALLOWED");
    });
    return BatchUploadCredentialsSchema.parse({
      bucket: location.buckets[bucket],
      region: location.region,
      prefix: prefixOf(id),
      sts: {
        tmpSecretId: grant.accessKeyId,
        tmpSecretKey: grant.secretAccessKey,
        sessionToken: grant.sessionToken,
        startTime: (grant.startTime ?? deps.clock.now()).toISOString(),
        expiredTime: grant.expiresAt.toISOString(),
      },
      chunkSize: 8 * 1024 * 1024,
      fileParallel: 3,
      chunkParallel: 4,
      expiresAt: grant.expiresAt.toISOString(),
    });
  };
  const update = (actor: MediaActor, itemId: string, raw: unknown, options: MediaOptions = {}) => {
    const body = parsed(UploadBatchItemUpdateBodySchema.safeParse(raw));
    const wakes: string[] = [];
    return deps.tx
      .run(async (tx) => {
        const before = await tx.uploadBatchItem.findUnique({ where: { id: itemId } });
        if (!before) throw new AppError("NOT_FOUND");
        const { facts } = await ownedBatch(tx, deps, actor, before.uploadBatchId, {
          lockTarget: true,
        });
        await lockBatchRecords(tx, before.uploadBatchId);
        const batch = await batchOf(tx, before.uploadBatchId),
          item = batch.uploadBatchItems.find((i) => i.id === itemId)!;
        if (["skipped", "replaced"].includes(item.state)) throw new AppError("STATE_NOT_ALLOWED");
        await lockBatchFiles(tx, batch.id);
        const now = deps.clock.now();
        if ("episodeNo" in body) {
          if (body.episodeNo !== null && body.episodeNo > batch.expectedCount)
            throw new AppError("VALIDATION_FAILED");
          const occupied = batch.uploadBatchItems.find(
            (i) =>
              i.id !== itemId &&
              !["skipped", "replaced"].includes(i.state) &&
              i.episodeNo === body.episodeNo,
          );
          if (body.episodeNo !== null && occupied)
            throw new AppError("BATCH_EPISODE_TAKEN", {
              details: { uploadBatchItemId: occupied.id },
            });
          let next = item.state;
          if (batch.purpose === "final_release") {
            const master =
              body.episodeNo === null
                ? null
                : await deps.batches.currentMaster(tx, batch, body.episodeNo);
            await tx.productionRecord.update({
              where: { fileId: item.fileId },
              data: {
                episodeNo: body.episodeNo,
                dramaEpisodeMasterId: master,
                masterSource: master ? "current_fallback" : null,
                ...(["checked", "rejected"].includes(item.state)
                  ? { pipelineState: "checking" }
                  : {}),
                updatedAt: now,
              },
            });
            if (["checked", "rejected"].includes(item.state)) {
              await tx.mediaCheck.deleteMany({ where: { fileId: item.fileId } });
              next = "uploaded";
              if (!deps.queueBatchProbe) throw new AppError("PROVIDER_UNAVAILABLE");
              wakes.push(await deps.queueBatchProbe(tx, item.fileId, batch.id));
            }
          }
          await tx.uploadBatchItem.update({
            where: { id: itemId },
            data: { episodeNo: body.episodeNo, matchMethod: "manual", state: next, updatedAt: now },
          });
        } else if ("skip" in body) {
          if (
            batch.scope !== "partial" ||
            !["pending", "rejected"].includes(item.state) ||
            activeItems(batch.uploadBatchItems).length < 2
          )
            throw new AppError("STATE_NOT_ALLOWED");
          await tx.uploadBatchItem.update({
            where: { id: itemId },
            data: { state: "skipped", updatedAt: now },
          });
        } else {
          validateBatchFiles(batch.purpose, [body.replacementFile], batch.expectedCount);
          const peers = activeItems(batch.uploadBatchItems).filter((i) => i.id !== itemId);
          const peerFiles = await tx.fileObject.findMany({
            where: { id: { in: peers.map((i) => i.fileId) } },
          });
          if (
            peers.some((i) => i.originalName === body.replacementFile.originalName) ||
            peerFiles.some(
              (f) => f.status === "pending" && f.clientToken === body.replacementFile.clientToken,
            )
          )
            throw new AppError("BATCH_FILE_INVALID", {
              details: { files: [{ index: 0, reason: "duplicate_name_or_token" }] },
            });
          const old = await tx.fileObject.findUniqueOrThrow({ where: { id: item.fileId } });
          if (old.confirmingUntil && old.confirmingUntil > now)
            throw new AppError("CONFIRM_IN_PROGRESS");
          if (old.status === "pending")
            await tx.fileObject.update({
              where: { id: old.id },
              data: {
                status: "expired",
                incomingKey: null,
                incomingBucket: null,
                confirmingUntil: null,
                updatedAt: now,
              },
            });
          await tx.uploadBatchItem.update({
            where: { id: itemId },
            data: { state: "replaced", updatedAt: now },
          });
          const file = await createBatchFile(tx, deps, batch, facts, body.replacementFile);
          await tx.uploadBatchItem.create({
            data: {
              id: uuidv7(),
              uploadBatchId: batch.id,
              fileId: file.id,
              originalName: body.replacementFile.originalName,
              episodeNo: item.episodeNo,
              matchMethod: item.matchMethod,
              state: "pending",
              createdAt: now,
              updatedAt: now,
            },
          });
          await createProduction(tx, deps, batch, file.id, item.episodeNo);
        }
        await touchBatch(tx, batch, now);
        // Original-master mapping changes preserve ready; commit performs the coverage check again.
        if (!("episodeNo" in body && batch.purpose === "drama_master"))
          await convergeBatch(tx, deps, batch.id);
        await audit(tx, actor, batch, "update", "调整上传条目");
        return batchView(tx, deps, actor, batch.id);
      }, options)
      .then(async (value) => {
        if (!options.idem?.replayed) for (const jobId of wakes) await notifyPromote(deps, jobId);
        return value;
      });
  };
  const complete = async (
    actor: MediaActor,
    itemId: string,
    raw: unknown,
    options: MediaOptions = {},
  ) => {
    empty(raw);
    const result = await createThreePhaseRunner({ tx: deps.tx, clock: deps.clock }).run(
      {
        claim: async (tx) => {
          const item = await tx.uploadBatchItem.findUnique({ where: { id: itemId } });
          if (!item) throw new AppError("NOT_FOUND");
          await ownedBatch(tx, deps, actor, item.uploadBatchId, { lockTarget: true });
          await lockBatchRecords(tx, item.uploadBatchId);
          const batch = await batchOf(tx, item.uploadBatchId),
            current = batch.uploadBatchItems.find((i) => i.id === itemId)!;
          if (batch.state !== "uploading" || ["skipped", "replaced"].includes(current.state))
            throw new AppError("STATE_NOT_ALLOWED");
          await lockBatchFiles(tx, batch.id);
          const file = await tx.fileObject.findUniqueOrThrow({ where: { id: item.fileId } }),
            now = deps.clock.now();
          if (["promoting", "stored"].includes(file.status))
            return { file, item, marker: null as Date | null };
          if (file.status !== "pending")
            throw new AppError(file.status === "expired" ? "UPLOAD_EXPIRED" : "STATE_NOT_ALLOWED");
          if (file.uploadExpiresAt && file.uploadExpiresAt <= now)
            throw new AppError("UPLOAD_EXPIRED");
          if (file.confirmingUntil && file.confirmingUntil > now)
            throw new AppError("CONFIRM_IN_PROGRESS");
          const marker = new Date(now.getTime() + 30_000);
          await tx.fileObject.update({
            where: { id: file.id },
            data: { confirmingUntil: marker, updatedAt: now },
          });
          return { file, item, marker };
        },
        external: async ({ file, marker }) => {
          if (!marker) return null;
          const ref = { bucket: file.incomingBucket as StorageBucket, key: file.incomingKey! },
            head = providerValue(await deps.storage.head(ref));
          if (!head.exists) throw new AppError("UPLOAD_NOT_FOUND");
          if (!Number.isSafeInteger(head.size) || head.size < 0 || !head.etag)
            throw new AppError("PROVIDER_UNAVAILABLE");
          if (BigInt(head.size) !== file.declaredSize)
            throw new AppError("UPLOAD_REJECTED", { details: { rejectReason: "size_mismatch" } });
          const read = await deps.storage.readPrefix({
            ...ref,
            bytes: 4096,
            ifMatchEtag: head.etag,
          });
          if (!read.ok && read.reason === "rejected")
            throw new AppError("UPLOAD_REJECTED", {
              details: { rejectReason: "changed_after_confirm" },
            });
          const bytes = providerValue(read);
          if (!(bytes instanceof Uint8Array) || bytes.length > 4096)
            throw new AppError("PROVIDER_UNAVAILABLE");
          if (!matchesMagic(file.ext, bytes))
            throw new AppError("UPLOAD_REJECTED", { details: { rejectReason: "bad_magic" } });
          return { etag: head.etag, crc64: head.crc64 ?? null };
        },
        settle: async (tx, object, intent) => {
          await ownedBatch(tx, deps, actor, intent.item.uploadBatchId, { lockTarget: true });
          await lockBatchRecords(tx, intent.item.uploadBatchId);
          const item = await tx.uploadBatchItem.findUniqueOrThrow({ where: { id: itemId } });
          if (item.fileId !== intent.file.id || ["skipped", "replaced"].includes(item.state))
            throw new AppError("STATE_NOT_ALLOWED");
          await lockBatchFiles(tx, item.uploadBatchId);
          if (!intent.marker) return itemView(tx, item);
          const now = deps.clock.now(),
            changed = await tx.fileObject.updateMany({
              where: { id: item.fileId, status: "pending", confirmingUntil: intent.marker },
              data: {
                status: "promoting",
                confirmingUntil: null,
                incomingEtag: object!.etag,
                incomingCrc64: object!.crc64,
                updatedAt: now,
              },
            });
          if (changed.count !== 1) throw new AppError("CONFIRM_IN_PROGRESS");
          await tx.mediaJob.createMany({
            data: [
              {
                id: uuidv7(),
                kind: "promote",
                provider: "local",
                mode: "local",
                subjectType: "file_object",
                subjectId: item.fileId,
                parentType: "upload_batch",
                parentId: item.uploadBatchId,
                dedupeKey: `promote:${item.fileId}`,
                state: "queued",
                input: {},
                nextRunAt: now,
                deadlineAt: new Date(now.getTime() + 30 * 60_000),
                createdAt: now,
                updatedAt: now,
              },
            ],
            skipDuplicates: true,
          });
          await emitFile(tx, deps, actor, intent.file, "file.uploaded");
          await touchBatch(tx, await batchOf(tx, item.uploadBatchId), now);
          return itemView(tx, item);
        },
        compensate: async (tx, intent, failure) => {
          if (!intent.marker) return;
          await lockBatchRecords(tx, intent.item.uploadBatchId);
          await lockRows(tx, "file_object", [intent.file.id]);
          const rejected = failure.error.error === "UPLOAD_REJECTED",
            reason = (failure.error.details as { rejectReason?: string })?.rejectReason;
          const now = deps.clock.now(),
            changed = await tx.fileObject.updateMany({
              where: { id: intent.file.id, status: "pending", confirmingUntil: intent.marker },
              data: {
                confirmingUntil: null,
                ...(rejected ? { status: "rejected", rejectReason: reason ?? "bad_magic" } : {}),
                updatedAt: now,
              },
            });
          if (rejected && changed.count) {
            await tx.uploadBatchItem.updateMany({
              where: { id: itemId, state: "pending", fileId: intent.file.id },
              data: { state: "rejected", updatedAt: now },
            });
            await emitFile(
              tx,
              deps,
              actor,
              await tx.fileObject.findUniqueOrThrow({ where: { id: intent.file.id } }),
              "file.rejected",
            );
          }
        },
      },
      options,
    );
    if (!options.idem?.replayed && result.fileStatus === "promoting") {
      const job = await deps.tx.run((tx) =>
        tx.mediaJob.findUnique({
          where: { dedupeKey: `promote:${result.fileId}` },
          select: { id: true },
        }),
      );
      if (job) await notifyPromote(deps, job.id);
    }
    return result;
  };
  const cancel = (actor: MediaActor, id: string, raw: unknown, options: MediaOptions = {}) => {
    empty(raw);
    return deps.tx.run(async (tx) => {
      await ownedBatch(tx, deps, actor, id, { lockTarget: true });
      await lockBatchRecords(tx, id);
      const batch = await batchOf(tx, id);
      if (!["matching", "ready"].includes(batch.state)) throw new AppError("STATE_NOT_ALLOWED");
      const files = await tx.fileObject.findMany({ where: { uploadBatchId: id } });
      await lockRows(
        tx,
        "file_object",
        files.map((f) => f.id),
      );
      const now = deps.clock.now();
      if (files.some((f) => f.confirmingUntil && f.confirmingUntil > now))
        throw new AppError("CONFIRM_IN_PROGRESS");
      await tx.fileObject.updateMany({
        where: { uploadBatchId: id, status: "pending" },
        data: {
          status: "expired",
          incomingKey: null,
          incomingBucket: null,
          confirmingUntil: null,
          updatedAt: now,
        },
      });
      for (const f of files.filter((f) => f.status === "stored"))
        await release(deps, tx, {
          fileId: f.id,
          entityId: f.entityId,
          storeId: f.storeId,
          refType: "upload_batch",
          refId: id,
          role: "main",
          keepUntil: new Date(now.getTime() + 3 * 86_400_000),
        });
      await tx.uploadBatch.update({ where: { id }, data: { state: "canceled", updatedAt: now } });
      await audit(tx, actor, batch, "cancel", "取消上传批次");
      return batchView(tx, deps, actor, id);
    }, options);
  };
  const commit = (actor: MediaActor, id: string, raw: unknown, options: MediaOptions = {}) => {
    empty(raw);
    return deps.tx.run(async (tx) => {
      const { facts } = await ownedBatch(tx, deps, actor, id, { lockTarget: true });
      await lockRows(tx, "upload_batch", [id]);
      const batch = await batchOf(tx, id);
      if (batch.purpose !== "drama_master")
        throw new AppError("BATCH_PURPOSE_MISMATCH", { details: { purpose: batch.purpose } });
      if (batch.state !== "ready") throw new AppError("STATE_NOT_ALLOWED");
      if (facts.expectedCount !== batch.expectedCount) throw new AppError("PRECONDITION_CHANGED");
      const coverage = batchCoverage(
          batch.uploadBatchItems,
          batch.expectedCount,
          batch.scope,
          false,
        ),
        items = activeItems(batch.uploadBatchItems);
      if (!items.length || !coverageComplete(coverage))
        throw new AppError("BATCH_MATCH_INCOMPLETE", { details: coverage });
      if (items.some((i) => i.state !== "checked")) throw new AppError("STATE_NOT_ALLOWED");
      await lockRows(tx, "file_object", [
        ...items.map((i) => i.fileId),
        ...facts.masters
          .filter((m) => items.some((i) => i.episodeNo === m.episodeNo))
          .map((m) => m.fileId),
      ]);
      const values = [];
      for (const i of items) {
        const f = await tx.fileObject.findUniqueOrThrow({
          where: { id: i.fileId },
          include: { mediaInfo: true },
        });
        const check = await tx.mediaCheck.findUnique({ where: { fileId: f.id } });
        if (
          f.status !== "stored" ||
          f.category !== "drama_master" ||
          f.moderationState === "block" ||
          check?.gate !== "pass" ||
          f.mediaInfo?.durationMs === null ||
          f.mediaInfo?.durationMs === undefined ||
          f.mediaInfo.durationMs <= 0
        )
          throw new AppError("FILE_NOT_AVAILABLE");
        values.push({
          episodeNo: i.episodeNo!,
          fileId: f.id,
          durationMs: f.mediaInfo.durationMs,
        });
      }
      const masters = await deps.batches.commitMasters(tx, {
        batch,
        staff: staffOf(actor),
        identity: actor.identity,
        items: values,
      });
      const now = deps.clock.now();
      await tx.uploadBatch.update({
        where: { id },
        data: { state: "committed", committedAt: now, updatedAt: now },
      });
      await audit(
        tx,
        actor,
        batch,
        "commit",
        `提交第${values.map((v) => v.episodeNo).join("、")}集原片`,
      );
      return { batch: await batchView(tx, deps, actor, id), masters: [...masters] };
    }, options);
  };
  return { create, get, start, refreshCredentials, update, complete, cancel, commit };
}
