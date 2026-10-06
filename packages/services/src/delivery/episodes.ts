import type { EpisodeOutput } from "@liyoxi/db";
import type { EpisodeRegisterBody, InspectEpisodesBody } from "@liyoxi/contract";
import { record } from "../audit/index.js";
import type { StaffContext } from "../authz/index.js";
import { paramsAt } from "../config/index.js";
import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import {
  consumeFinalReleaseBatch,
  ensureProductionStubs,
  recordAdoptedStoreAssets,
} from "../media/index.js";
import { staffBriefs } from "../staff/index.js";
import type { DeliveryDeps } from "./context.js";
import { lockTickets, ticketOf, iso } from "./repo.js";
import type { TicketRow } from "./repo.js";
import { invalid, quality, insertQuality, productionReady, unpaused } from "./quality.js";
import type { QualityInput } from "./quality.js";
import { qcView } from "./quality-views.js";
import { reevaluate } from "./reevaluate.js";
export async function episodeView(tx: Tx, e: EpisodeOutput) {
  const file = await tx.fileObject.findUniqueOrThrow({ where: { id: e.fileId } }),
    p = await tx.productionRecord.findUnique({ where: { fileId: e.fileId } }),
    c = await tx.mediaCheck.findUnique({ where: { fileId: e.fileId } }),
    r = e.qcRecordId ? await tx.qcRecord.findUnique({ where: { id: e.qcRecordId } }) : null;
  return {
    episodeOutputId: e.id,
    episodeNo: e.episodeNo,
    variant: e.variant,
    revisionNo: e.revisionNo,
    fileId: e.fileId,
    fileName: file.originalName,
    sizeBytes: e.sizeBytes.toString(),
    durationMs: e.durationMs,
    source: e.source,
    status: e.status,
    isCurrent: e.isCurrent,
    deliveryReissueId: e.deliveryReissueId,
    production: p
      ? {
          pipelineState: p.pipelineState,
          gate: c?.gate ?? null,
          softWarnCount: Array.isArray(c?.soft) ? c.soft.length : 0,
          aigcState: p.aigcState,
        }
      : null,
    qc: r
      ? {
          qcRecordId: r.id,
          verdict: r.verdict,
          rejectReason: r.rejectReason,
          inspectedAt: iso(r.inspectedAt)!,
          inspectedBy: (await staffBriefs(tx, [r.inspectedByStaffId]))[0]!,
        }
      : null,
    uploadedBy: (await staffBriefs(tx, [e.uploadedByStaffId]))[0]!,
    uploadedAt: iso(e.uploadedAt)!,
  };
}
export async function episodeGrid(tx: Tx, t: TicketRow) {
  const rows = await tx.episodeOutput.findMany({
      where: { deliveryTicketId: t.id, entityId: t.entityId, storeId: t.storeId },
      orderBy: [{ revisionNo: "desc" }, { id: "desc" }],
    }),
    current = rows.filter((r) => r.isCurrent),
    views = await Promise.all(rows.map((r) => episodeView(tx, r)));
  const view = (r: EpisodeOutput | undefined) =>
    r ? views.find((v) => v.episodeOutputId === r.id)! : null;
  return {
    totalEpisodes: t.orderItem.episodeCount,
    currentPassedCount: current.filter((r) => r.status === "qc_passed").length,
    currentTotalBytes: current.reduce((s, r) => s + r.sizeBytes, 0n).toString(),
    episodes: Array.from({ length: t.orderItem.episodeCount }, (_, i) => ({
      episodeNo: i + 1,
      current: view(current.find((r) => r.episodeNo === i + 1)),
      latest: view(rows.find((r) => r.episodeNo === i + 1 && r.variant === "common")),
      replacement: view(rows.find((r) => r.episodeNo === i + 1 && r.deliveryReissueId !== null)),
    })),
    packageQc: await qcView(
      tx,
      t.qcRecords.find((q) => q.targetType === "delivery_ticket") ?? null,
    ),
    fileNamePattern: `${(t.orderItem.dramaSnapshot as { title: string }).title}_第NN集.mp4`,
  };
}
export async function registerEpisodes(
  tx: Tx,
  deps: DeliveryDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  b: EpisodeRegisterBody,
) {
  await ticketOf(
    tx,
    id,
    staff.moduleLevels.delivery === "o"
      ? { ...staff, moduleLevels: { ...staff.moduleLevels, delivery: "v" } }
      : staff,
  );
  await lockTickets(tx, [id]);
  const t = await ticketOf(tx, id);
  unpaused(t);
  if (!["batch_compose", "delivering"].includes(t.step) || t.deliveredAt || b.reissueId)
    throw new AppError("EPISODE_REGISTER_NOT_ALLOWED", {
      details: { step: t.step, reason: b.reissueId ? "reissue_required" : "step" },
    });
  if (t.editorId && t.editorId !== staff.staff.id) throw new AppError("PERMISSION_DENIED");
  if (!!b.items === !!b.uploadBatchId) throw invalid("items", "逐集与批次须二选一");
  const batch = b.uploadBatchId
    ? await tx.uploadBatch.findUnique({
        where: { id: b.uploadBatchId },
        include: { uploadBatchItems: true },
      })
    : null;
  if (b.uploadBatchId && (!batch || batch.targetId !== t.orderItemId))
    throw new AppError("NOT_FOUND");
  const items: NonNullable<EpisodeRegisterBody["items"]> =
    b.items ??
    batch!.uploadBatchItems
      .filter((r) => !["skipped", "replaced"].includes(r.state))
      .map((r) => ({ episodeNo: r.episodeNo ?? 0, fileId: r.fileId, variant: "common" as const }));
  if (
    !items.length ||
    items.length > 100 ||
    new Set(items.map((r) => r.episodeNo)).size !== items.length ||
    items.some((r) => r.episodeNo < 1 || r.episodeNo > t.orderItem.episodeCount)
  )
    throw invalid("items", "集号越界或重复");
  const rows = await tx.episodeOutput.findMany({
    where: { deliveryTicketId: id, episodeNo: { in: items.map((r) => r.episodeNo) } },
  });
  await lockRows(
    tx,
    "episode_output",
    rows.map((r) => r.id),
  );
  const adopted = items.filter((r) => r.sampleId).map((r) => r.sampleId!);
  await lockRows(tx, "sample", adopted);
  const samples = await tx.sample.findMany({
    where: {
      id: { in: adopted },
      deliveryTicketId: id,
      status: "confirmed",
      entityId: t.entityId,
      storeId: t.storeId,
    },
  });
  if (samples.length !== adopted.length)
    throw new AppError("FILE_NOT_USABLE", { details: { fileIds: [], reason: "context_mismatch" } });
  const files = items
    .filter((r) => r.fileId)
    .map((r) => ({
      fileId: r.fileId!,
      kind: "final" as const,
      orderItemId: t.orderItemId,
      episodeNo: r.episodeNo,
      entityId: t.entityId,
      storeId: t.storeId,
      productionTier: t.orderItem.productionModel,
      uploadedByStaffId: staff.staff.id,
    }));
  const media = await ensureProductionStubs(tx, deps, files, async () => {
    await recordAdoptedStoreAssets(tx, deps, ctx, {
      entityId: t.entityId,
      storeId: t.storeId,
      orderItemId: t.orderItemId,
      storeAssetIds: b.adoptedStoreAssetIds ?? [],
    });
    if (batch) await lockRows(tx, "upload_batch", [batch.id]);
    // 样片采用的文件也在一次排序集合里预锁；避免后续 link 找到较小 UUID。
    await lockRows(tx, "file_object", [
      ...files.map((r) => r.fileId),
      ...samples.map((r) => r.fileId),
    ]);
  });
  const insert = async () => {
    const outputs: EpisodeOutput[] = [];
    const now = deps.clock.now();
    for (const i of [...items].sort((a, b) => a.episodeNo - b.episodeNo)) {
      const sample = i.sampleId ? samples.find((s) => s.id === i.sampleId) : null,
        info = i.fileId ? media.find((m) => m.file.id === i.fileId) : null,
        fileId = sample?.fileId ?? info!.file.id;
      const f = await tx.fileObject.findUniqueOrThrow({ where: { id: fileId } });
      if (
        f.status !== "stored" ||
        f.moderationState === "block" ||
        f.entityId !== t.entityId ||
        f.storeId !== t.storeId
      )
        throw new AppError("FILE_NOT_USABLE", {
          details: { fileIds: [fileId], reason: "scope_mismatch" },
        });
      if (info && !["manual_upload", "normalized", "restamped"].includes(info.record.source))
        throw new AppError("FILE_NOT_USABLE", {
          details: { fileIds: [fileId], reason: "context_mismatch" },
        });
      await tx.episodeOutput.updateMany({
        where: {
          deliveryTicketId: id,
          episodeNo: i.episodeNo,
          variant: "common",
          deliveryReissueId: null,
          status: { in: ["uploaded", "qc_passed", "qc_rejected", "check_rejected"] },
        },
        data: { status: "replaced", isCurrent: false, updatedAt: now },
      });
      const m = await tx.episodeOutput.aggregate({
          where: { deliveryTicketId: id, episodeNo: i.episodeNo, variant: "common" },
          _max: { revisionNo: true },
        }),
        mi = await tx.mediaInfo.findUnique({ where: { fileId } });
      const e = await tx.episodeOutput.create({
        data: {
          id: uuidv7(),
          entityId: t.entityId,
          storeId: t.storeId,
          deliveryTicketId: id,
          episodeNo: i.episodeNo,
          variant: "common",
          revisionNo: (m._max.revisionNo ?? 0) + 1,
          fileId,
          sizeBytes: f.sizeBytes!,
          durationMs: sample?.durationMs ?? mi?.durationMs ?? null,
          source: sample ? "sample_adopted" : info!.record.source,
          status: "uploaded",
          isCurrent: false,
          uploadedByStaffId: staff.staff.id,
          uploadedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
      await deps.media.link(tx, {
        fileId,
        entityId: t.entityId,
        storeId: t.storeId,
        refType: "episode_output",
        refId: e.id,
        role: "main",
      });
      outputs.push(e);
    }
    if (!t.editorId)
      await tx.deliveryTicket.update({
        where: { id },
        data: { editorId: staff.staff.id, updatedAt: now },
      });
    await record(
      tx,
      ctx.actor,
      {
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        authMethod: null,
        sessionId: null,
      },
      {
        stream: "activity",
        category: "delivery",
        action: "delivery.episode.register",
        meta: { editorClaimed: !t.editorId },
        summary: `登记成片第 ${items.map((i) => i.episodeNo).join("、")} 集`,
        target: { type: "delivery_ticket", id },
        entityId: t.entityId,
        storeId: t.storeId,
      },
    );
    return { value: outputs, refs: outputs.map((e) => ({ fileId: e.fileId, refId: e.id })) };
  };
  const registered = batch
    ? await consumeFinalReleaseBatch(
        tx,
        deps,
        {
          entityId: t.entityId,
          storeId: t.storeId,
          orderItemId: t.orderItemId,
          batchId: batch.id,
          expectedCount: t.orderItem.episodeCount,
          candidateItems: items.map((i) => ({
            episodeNo: i.episodeNo,
            fileId: i.fileId!,
            variant: "common",
          })),
        },
        () => insert(),
      )
    : (await insert()).value;
  await reevaluate(tx, deps, ctx, t.id);
  return registered;
}
export async function inspectEpisodes(
  tx: Tx,
  deps: DeliveryDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  b: InspectEpisodesBody,
) {
  await ticketOf(tx, id, staff);
  await lockTickets(tx, [id]);
  const t = await ticketOf(tx, id, staff);
  unpaused(t);
  if (!["batch_compose", "delivering"].includes(t.step)) throw new AppError("STATE_NOT_ALLOWED");
  const all = await tx.episodeOutput.findMany({
    where: { deliveryTicketId: id },
    orderBy: { revisionNo: "desc" },
  });
  await lockRows(
    tx,
    "episode_output",
    all.map((e) => e.id),
  );
  const rows = all.filter((e) => b.episodeOutputIds.includes(e.id));
  if (
    rows.length !== b.episodeOutputIds.length ||
    new Set(b.episodeOutputIds).size !== b.episodeOutputIds.length
  )
    throw invalid("episodeOutputIds", "成片不属于本工单或重复");
  if (
    b.exceptions?.some((e) => !b.episodeOutputIds.includes(e.episodeOutputId)) ||
    new Set(b.exceptions?.map((e) => e.episodeOutputId)).size !== (b.exceptions?.length ?? 0)
  )
    throw invalid("exceptions", "例外行重复或不在本次质检内");
  await lockRows(
    tx,
    "production_record",
    rows.map((e) => e.fileId),
    "share",
  );
  const poster =
    (t.orderItem.dramaSnapshot as { posterFileId?: string }).posterFileId ??
    (await tx.drama.findUnique({ where: { id: t.dramaId } }))?.posterFileId;
  await lockRows(tx, "file_object", [...rows.map((e) => e.fileId), ...(poster ? [poster] : [])]);
  const four = (await paramsAt(tx, ["qc.episode.four_eyes"], deps.clock.now()))[
      "qc.episode.four_eyes"
    ],
    results = [];
  for (const e of rows) {
    if (e.status !== "uploaded" || e.deliveryReissueId) throw new AppError("STATE_NOT_ALLOWED");
    const latest = all.find((r) => r.episodeNo === e.episodeNo && r.variant === e.variant);
    if (latest?.id !== e.id)
      throw new AppError("EPISODE_NOT_LATEST", {
        details: { episodeOutputId: e.id, latestEpisodeOutputId: latest?.id },
      });
    if (four && e.uploadedByStaffId === staff.staff.id) throw new AppError("QC_SELF_INSPECTION");
    const p = await productionReady(tx, e.fileId),
      exception = b.exceptions?.find((r) => r.episodeOutputId === e.id),
      q = await quality(
        tx,
        "qc.episode",
        {
          checklistVersionNo: b.checklistVersionNo,
          results: exception?.results ?? b.defaultResults,
          rejectReason: exception ? exception.rejectReason : b.defaultRejectReason,
        },
        p.aigcState,
      ),
      r = await insertQuality(tx, deps, t, staff.staff.id, "episode_output", e.id, q),
      now = deps.clock.now();
    if (q.verdict === "pass")
      await tx.episodeOutput.updateMany({
        where: {
          deliveryTicketId: id,
          episodeNo: e.episodeNo,
          variant: e.variant,
          isCurrent: true,
          id: { not: e.id },
        },
        data: { isCurrent: false, status: "replaced", updatedAt: now },
      });
    await tx.episodeOutput.update({
      where: { id: e.id },
      data: {
        status: q.verdict === "pass" ? "qc_passed" : "qc_rejected",
        isCurrent: q.verdict === "pass",
        qcRecordId: r.id,
        updatedAt: now,
      },
    });
    results.push({
      episodeOutputId: e.id,
      episodeNo: e.episodeNo,
      verdict: q.verdict,
      qcRecordId: r.id,
    });
  }
  const failed = results.filter((r) => r.verdict === "fail");
  if (failed.length)
    await deps.events.emit(tx, ctx, {
      type: "ticket.episode_qc_failed",
      aggregate: { type: "delivery_ticket", id },
      entityId: t.entityId,
      storeId: t.storeId,
      payload: {
        v: 1,
        deliveryTicketId: id,
        orderItemId: t.orderItemId,
        episodeNos: failed.map((r) => r.episodeNo),
        qcRecordIds: failed.map((r) => r.qcRecordId),
      },
    });
  await reevaluate(tx, deps, ctx, id);
  await record(
    tx,
    ctx.actor,
    {
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      authMethod: null,
      sessionId: null,
    },
    {
      stream: "activity",
      category: "delivery",
      action: "delivery.episode.inspect",
      summary: `成片质检 ${results.length} 集`,
      target: { type: "delivery_ticket", id },
      entityId: t.entityId,
      storeId: t.storeId,
    },
  );
  return results;
}
export async function inspectPackage(
  tx: Tx,
  deps: DeliveryDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  b: QualityInput,
) {
  await ticketOf(tx, id, staff);
  await lockTickets(tx, [id]);
  const t = await ticketOf(tx, id, staff);
  unpaused(t);
  if (t.step !== "batch_compose") throw new AppError("STATE_NOT_ALLOWED");
  const q = await quality(tx, "qc.package", b),
    r = await insertQuality(tx, deps, t, staff.staff.id, "delivery_ticket", id, q);
  await reevaluate(tx, deps, ctx, id);
  await record(
    tx,
    ctx.actor,
    {
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      authMethod: null,
      sessionId: null,
    },
    {
      stream: "activity",
      category: "delivery",
      action: "delivery.package.inspect",
      summary: "成片包质检",
      target: { type: "delivery_ticket", id },
      entityId: t.entityId,
      storeId: t.storeId,
    },
  );
  return r;
}
