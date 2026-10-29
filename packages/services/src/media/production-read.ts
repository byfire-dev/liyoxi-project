import { ProductionRecordQuerySchema, ProductionRecordViewSchema } from "@liyoxi/contract";
import type { ProductionRecordQuery, ProductionRecordView } from "@liyoxi/contract";
import type { ProductionRecord } from "@liyoxi/db";
import { assertAccess } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { BoundMediaDeps, MediaActor } from "./context.js";
import { manualRecheckState } from "./production-recheck.js";

export function requireProductionActor(actor: MediaActor) {
  if (
    !actor.staff ||
    actor.identity.actor.type !== "staff" ||
    actor.identity.actor.id !== actor.staff.staff.id
  )
    throw new AppError("PERMISSION_DENIED");
  assertAccess(actor.staff, { module: { module: "delivery", need: "view" }, permission: null });
  return actor.staff;
}

async function view(
  deps: BoundMediaDeps,
  tx: Tx,
  actor: MediaActor,
  row: ProductionRecord,
): Promise<ProductionRecordView> {
  const access = deps.productionAccess;
  if (!access) throw new AppError("PROVIDER_UNAVAILABLE");
  const [info, check, master, uploadedBy] = await Promise.all([
    tx.mediaInfo.findUnique({
      where: { fileId: row.fileId },
      select: {
        aigcMeta: true,
        durationMs: true,
        width: true,
        height: true,
        displayWidth: true,
        displayHeight: true,
        vcodec: true,
        acodec: true,
        bitrateKbps: true,
        isFaststart: true,
      },
    }),
    tx.mediaCheck.findUnique({ where: { fileId: row.fileId } }),
    row.dramaEpisodeMasterId ? access.master(tx, row.dramaEpisodeMasterId) : null,
    row.uploadedByStaffId ? access.staff(tx, row.uploadedByStaffId) : null,
  ]);
  const actionable = ["ready", "rejected"].includes(row.pipelineState),
    ai = row.aiUsage as { used?: boolean },
    permissions = actor.staff!.permissions;
  const canRecover =
    row.pipelineState === "checking" &&
    permissions.has("production.recheck") &&
    (await manualRecheckState(tx, row, deps.clock.now())).recoverable;
  return ProductionRecordViewSchema.parse({
    productionRecordId: row.fileId,
    kind: row.kind,
    orderItemId: row.orderItemId,
    adId: row.adId,
    episodeNo: row.episodeNo,
    variant: row.variant,
    source: row.source,
    derivedFromFileId: row.derivedFromFileId,
    productionTier: row.productionTier,
    master: master
      ? { dramaEpisodeMasterId: master.id, revNo: master.revNo, masterSource: row.masterSource }
      : null,
    headAdVersionId: row.headAdVersionId,
    tailAdVersionId: row.tailAdVersionId,
    aiUsage: row.aiUsage,
    aigcState: row.aigcState,
    aigcOrigin: row.aigcOrigin,
    aigcMeta: info?.aigcMeta ?? null,
    pipelineState: row.pipelineState,
    check: check
      ? {
          profile: check.profile,
          ruleVersion: check.ruleVersion,
          gate: check.gate,
          hard: check.hard,
          soft: check.soft,
          checkedAt: check.checkedAt.toISOString(),
        }
      : null,
    media: info
      ? {
          durationMs: info.durationMs,
          width: info.width,
          height: info.height,
          displayWidth: info.displayWidth,
          displayHeight: info.displayHeight,
          vcodec: info.vcodec,
          acodec: info.acodec,
          bitrateKbps: info.bitrateKbps,
          isFaststart: info.isFaststart,
        }
      : null,
    uploadedBy,
    createdAt: row.createdAt.toISOString(),
    actions: [
      ...(actionable &&
      ["final", "ad"].includes(row.kind) &&
      permissions.has("production.normalize")
        ? ["normalize"]
        : []),
      ...(actionable && ai.used === false && permissions.has("production.restamp")
        ? ["restamp"]
        : []),
      ...((actionable || canRecover) && permissions.has("production.recheck") ? ["recheck"] : []),
    ],
  });
}

/** Scope is decided by the actual order/ad owner before paging or exposing any facts. */
export async function listProductionRecords(
  deps: BoundMediaDeps,
  actor: MediaActor,
  raw: ProductionRecordQuery,
) {
  requireProductionActor(actor);
  const query = ProductionRecordQuerySchema.parse(raw);
  if (!deps.productionAccess) throw new AppError("PROVIDER_UNAVAILABLE");
  return deps.tx.run(async (tx) => {
    const rows = await tx.productionRecord.findMany({
      where: {
        ...(query.fileIds ? { fileId: { in: query.fileIds } } : {}),
        ...(query.orderItemId ? { orderItemId: query.orderItemId } : {}),
        ...(query.adId ? { adId: query.adId } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.episodeNo ? { episodeNo: query.episodeNo } : {}),
        ...(query.pipelineState ? { pipelineState: query.pipelineState } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { fileId: "desc" }],
    });
    const visible: ProductionRecord[] = [];
    for (const row of rows) {
      try {
        await deps.productionAccess!.require(tx, actor, row);
        visible.push(row);
      } catch (error) {
        if (!(error instanceof AppError) || error.error !== "NOT_FOUND") throw error;
      }
    }
    const start = (query.page - 1) * query.pageSize;
    return {
      items: await Promise.all(
        visible.slice(start, start + query.pageSize).map((row) => view(deps, tx, actor, row)),
      ),
      page: query.page,
      pageSize: query.pageSize,
      total: visible.length,
    };
  });
}
