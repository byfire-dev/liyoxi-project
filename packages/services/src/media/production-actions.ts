import {
  NormalizeBodySchema,
  RestampBodySchema,
  RecheckBodySchema,
  ProductionJobAcceptedSchema,
} from "@liyoxi/contract";
import type {
  NormalizeBody,
  RestampBody,
  RecheckBody,
  ProductionJobAccepted,
  ProductionRecordQuery,
} from "@liyoxi/contract";
import type { FileObject, MediaJob, ProductionRecord } from "@liyoxi/db";
import { assertAccess } from "../authz/index.js";
import { record as audit } from "../audit/index.js";
import { AppError, isUuid, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { BoundMediaDeps, MediaActor, MediaOptions } from "./context.js";
import {
  contextHash,
  enqueueProbe,
  manualDerivationTarget,
  json,
  requiredJson,
} from "./production.js";
import { DerivationInputSchema } from "./production-job-schemas.js";
import { listProductionRecords, requireProductionActor } from "./production-read.js";
import { jobBudget } from "./jobs/policy.js";
import type { ProductionPermission as Permission } from "./production-access.js";
import { manualRecheckState } from "./production-recheck.js";
const active = ["queued", "running", "submitting", "submitted"];
const actionable = (row: ProductionRecord) => ["ready", "rejected"].includes(row.pipelineState);
const deniedAction = (
  action: "normalize" | "restamp",
  reason: "kind" | "pipeline_state" | "already_declared" | "file_unavailable",
) => new AppError("PRODUCTION_ACTION_NOT_ALLOWED", { details: { action, reason } });

function accepted(
  sourceFileId: string,
  row: ProductionRecord,
  job: MediaJob,
): ProductionJobAccepted {
  return ProductionJobAcceptedSchema.parse({
    sourceFileId,
    productionRecordId: row.fileId,
    pipelineState: row.pipelineState,
    mediaJobId: job.id,
    jobKind: job.kind,
    jobState: job.state,
  });
}

export function createProductionActions(deps: BoundMediaDeps) {
  async function source(tx: Tx, actor: MediaActor, id: string, permission: Permission) {
    const row = await tx.productionRecord.findUnique({ where: { fileId: id } });
    if (!row) throw new AppError("NOT_FOUND");
    if (!deps.productionAccess) throw new AppError("PROVIDER_UNAVAILABLE");
    await deps.productionAccess.require(tx, actor, row, permission);
    // Parent domains establish their own earlier locks; media keeps the existing record/file order.
    await lockRows(tx, "production_record", [id]);
    await lockRows(tx, "file_object", [id]);
    const [current, file] = await Promise.all([
      tx.productionRecord.findUniqueOrThrow({ where: { fileId: id } }),
      tx.fileObject.findUniqueOrThrow({ where: { id } }),
    ]);
    if (current.orderItemId !== row.orderItemId || current.adId !== row.adId)
      throw new AppError("BUSY");
    return { row: current, file };
  }

  async function auditAction(
    tx: Tx,
    actor: MediaActor,
    file: FileObject,
    action: "normalize" | "restamp" | "recheck",
    result: ProductionJobAccepted,
    note?: string,
  ) {
    await audit(
      tx,
      actor.identity.actor,
      actor.audit ?? {
        requestId: actor.identity.requestId,
        ip: actor.identity.ip,
        userAgent: actor.identity.userAgent,
        authMethod: null,
        sessionId: null,
      },
      {
        stream: "ops",
        category: "system_ops",
        action: `media.production.${action}`,
        summary:
          action === "normalize"
            ? "发起制作文件规格化"
            : action === "restamp"
              ? "更正AI声明并补标"
              : "发起制作文件重检",
        target: { type: "file_object", id: file.id },
        ...(file.entityId
          ? { entityId: file.entityId, storeId: file.storeId }
          : { entityId: null, storeId: null }),
        before: null,
        after: result,
        fields: ["productionRecordId", "mediaJobId", "jobKind", "pipelineState"],
        ...(note ? { reason: { code: "other", text: note } } : {}),
      },
    );
  }

  function authorize(actor: MediaActor, id: string, permission: Permission) {
    const staff = requireProductionActor(actor);
    assertAccess(staff, { module: null, permission });
    if (!isUuid(id)) throw new AppError("VALIDATION_FAILED");
  }

  async function derive(
    actor: MediaActor,
    id: string,
    action: "normalize" | "restamp",
    body: NormalizeBody | RestampBody,
    options: MediaOptions,
  ) {
    authorize(actor, id, `production.${action}`);
    const production = deps.production;
    if (!production || (production.mode !== undefined && production.mode !== "full"))
      throw new AppError("PROVIDER_UNAVAILABLE");
    return deps.tx.run(async (tx) => {
      const { row, file } = await source(tx, actor, id, `production.${action}`);
      if (action === "normalize" && !["final", "ad"].includes(row.kind))
        throw deniedAction(action, "kind");
      if (!actionable(row)) throw deniedAction(action, "pipeline_state");
      if (action === "restamp" && (row.aiUsage as { used?: boolean }).used !== false)
        throw deniedAction(action, "already_declared");
      if (
        file.status !== "stored" ||
        file.moderationState === "block" ||
        !file.sha256 ||
        !file.etag ||
        !file.sizeBytes
      )
        throw deniedAction(action, "file_unavailable");
      const parameters = await production.parameters(tx),
        now = deps.clock.now();
      if (
        !Number.isSafeInteger(parameters.ruleVersion) ||
        parameters.ruleVersion < 1 ||
        parameters.ruleVersion > 32767
      )
        throw new AppError("VALIDATION_FAILED");
      const pending = await tx.mediaJob.findMany({
        where: {
          kind: action,
          subjectType: "file_object",
          subjectId: id,
          parentType: "production_record",
          state: { in: active },
          deadlineAt: { gt: now },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      for (const job of pending) {
        const input = DerivationInputSchema.safeParse(job.input);
        // A rules upgrade does not create a second manual operation while the first
        // still owns a valid destination. The existing worker decides whether it is stale.
        if (!input.success) continue;
        const target = await manualDerivationTarget(tx, job, input.data, file, row);
        if (target && ["uploading", "checking"].includes(target.record.pipelineState))
          return accepted(id, target.record, job);
      }
      const destinationFileId = uuidv7(),
        jobId = uuidv7(),
        objectKey = `derived/${destinationFileId}/${action}-v${parameters.ruleVersion}.mp4`,
        { fileId: _id, createdAt: _created, updatedAt: _updated, ...copy } = row,
        originalAi = row.aiUsage as { forcedByDrama?: boolean },
        aiUsage =
          action === "restamp"
            ? {
                used: true,
                tools: (body as RestampBody).tools,
                declaredBy: actor.staff!.staff.id,
                declaredAt: now.toISOString(),
                forcedByDrama: originalAi.forcedByDrama === true,
              }
            : row.aiUsage;
      await tx.fileObject.create({
        data: {
          id: destinationFileId,
          bucket: file.bucket,
          objectKey,
          category: file.category,
          scopeType: file.scopeType,
          entityId: file.entityId,
          storeId: file.storeId,
          uploadActorType: "system",
          uploadMode: "server",
          uploadBatchId: null,
          status: "pending",
          declaredSize: file.sizeBytes,
          declaredMime: "video/mp4",
          ext: "mp4",
          createdAt: now,
          updatedAt: now,
        },
      });
      const target = await tx.productionRecord.create({
        data: {
          ...copy,
          fileId: destinationFileId,
          source: action === "restamp" ? "restamped" : "normalized",
          derivedFromFileId: id,
          pipelineState: "uploading",
          uploadedByStaffId: null,
          aiUsage: requiredJson(aiUsage),
          similarity: json(row.similarity),
          aigcState: (aiUsage as { used?: boolean }).used ? "pending" : "not_required",
          aigcOrigin: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      const job = await tx.mediaJob.create({
        data: {
          id: jobId,
          kind: action,
          provider: action === "restamp" ? "mediatool" : production.cloud.status,
          mode: action === "restamp" ? "local" : "remote",
          subjectType: "file_object",
          subjectId: id,
          parentType: "production_record",
          parentId: destinationFileId,
          dedupeKey: `manual:${action}:${id}:v${parameters.ruleVersion}:${contextHash(row)}:${jobId}`,
          state: "queued",
          input: {
            fileId: id,
            destinationFileId,
            contextHash: contextHash(row),
            ruleVersion: parameters.ruleVersion,
            objectKey,
            template: production.config.templates.normalize,
            manual: {
              version: 1,
              sourceSha256: file.sha256,
              destinationContextHash: contextHash(target),
            },
          },
          maxAttempts: 3,
          nextRunAt: now,
          deadlineAt: new Date(now.getTime() + jobBudget(action)!.deadlineMs),
          createdAt: now,
          updatedAt: now,
        },
      });
      const result = accepted(id, target, job);
      await auditAction(tx, actor, file, action, result, body.note);
      return result;
    }, options);
  }

  async function recheck(
    actor: MediaActor,
    id: string,
    body: RecheckBody,
    options: MediaOptions = {},
  ) {
    authorize(actor, id, "production.recheck");
    RecheckBodySchema.parse(body);
    if (!deps.production) throw new AppError("PROVIDER_UNAVAILABLE");
    return deps.tx.run(async (tx) => {
      const { row, file } = await source(tx, actor, id, "production.recheck"),
        parameters = await deps.production!.parameters(tx),
        now = deps.clock.now();
      const round = await manualRecheckState(tx, row, now);
      if (row.pipelineState === "checking" && round.inflight)
        return accepted(id, row, round.inflight);
      if (!actionable(row) && !(row.pipelineState === "checking" && round.recoverable))
        throw new AppError("STATE_NOT_ALLOWED");
      const mediaJobId = await enqueueProbe(deps, tx, id, {
        generation: uuidv7(),
        ruleVersion: parameters.ruleVersion,
      });
      const current = await tx.productionRecord.update({
        where: { fileId: id },
        data: { pipelineState: "checking", updatedAt: now },
      });
      const job = await tx.mediaJob.findUniqueOrThrow({ where: { id: mediaJobId } }),
        result = accepted(id, current, job);
      await auditAction(tx, actor, file, "recheck", result);
      return result;
    }, options);
  }
  return {
    list: (actor: MediaActor, query: ProductionRecordQuery) =>
      listProductionRecords(deps, actor, query),
    normalize: (actor: MediaActor, id: string, body: NormalizeBody, options: MediaOptions = {}) =>
      derive(actor, id, "normalize", NormalizeBodySchema.parse(body), options),
    restamp: (actor: MediaActor, id: string, body: RestampBody, options: MediaOptions = {}) =>
      derive(actor, id, "restamp", RestampBodySchema.parse(body), options),
    recheck,
  };
}
