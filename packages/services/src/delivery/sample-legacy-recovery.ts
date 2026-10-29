import type { SamplePushBody } from "@liyoxi/contract";
import type { Prisma, QcRecord, Sample } from "@liyoxi/db";
import { record } from "../audit/index.js";
import { assertPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { DeliveryDeps } from "./context.js";
import { legacySampleRecoveryChecked } from "./machines.js";
import { orderSidePort } from "./ports.js";
import { productionEvidence } from "./production-guard.js";
import { insertQuality, invalid, quality } from "./quality.js";
import type { TicketRow } from "./repo.js";
import { moveSample, sampleAuditMeta } from "./sample-transitions.js";

export function isLegacySampleRecoveryCandidate(t: TicketRow, s: Sample) {
  return (
    t.step === "sample_confirm" &&
    t.pauseCount === 0 &&
    t.orderItem.phase === "producing" &&
    !["cancelled", "refunded"].includes(t.dramaOrder.status) &&
    t.currentSampleVersionNo === s.versionNo &&
    s.status === "pushed" &&
    s.previewChannels.length > 0 &&
    s.previewChannels.every((channel) => ["album", "portal", "wecom"].includes(channel)) &&
    s.decidedAt === null &&
    s.decidedByUserId === null &&
    s.decideClient === null &&
    s.confirmViewedVia === null &&
    s.onBehalfStaffId === null &&
    s.feedbackKind === null &&
    s.feedbackNote === null &&
    s.feedbackTimeMs === null &&
    s.feedbackFileIds.length === 0
  );
}

export function isLegacySampleQuality(qc: QcRecord | null, t: TicketRow, s: Sample) {
  return (
    qc !== null &&
    qc.verdict === "pass" &&
    qc.checklistCode === "qc.sample" &&
    qc.targetType === "sample" &&
    qc.targetId === s.id &&
    qc.deliveryTicketId === t.id &&
    qc.entityId === t.entityId &&
    qc.storeId === t.storeId &&
    qc.inspectedByStaffId !== s.uploadedByStaffId
  );
}

/** The caller holds the ad, parent and source sample locks and has checked the current flag. */
export async function recoverLegacySample(
  tx: Tx,
  deps: DeliveryDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  t: TicketRow,
  source: Sample,
  input: NonNullable<SamplePushBody["legacyRecovery"]>,
) {
  assertPermission(staff, "delivery.sample.qc", deps.clock.now());
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 200)
    throw invalid("legacyRecovery.reason", "须为10–200字");
  const latest = await tx.sample.findFirst({
    where: { deliveryTicketId: t.id },
    orderBy: { versionNo: "desc" },
  });
  if (input.versionNo !== source.versionNo || source.versionNo !== t.currentSampleVersionNo)
    throw new AppError("SAMPLE_VERSION_STALE", {
      details: { currentVersionNo: t.currentSampleVersionNo, currentSampleId: latest?.id ?? null },
    });
  if (!isLegacySampleRecoveryCandidate(t, source) || latest?.id !== source.id)
    throw new AppError("STATE_NOT_ALLOWED");
  if (source.uploadedByStaffId === staff.staff.id) throw new AppError("QC_SELF_INSPECTION");
  const sourceQc = source.qcRecordId
    ? await tx.qcRecord.findUnique({ where: { id: source.qcRecordId } })
    : null;
  if (!isLegacySampleQuality(sourceQc, t, source)) throw new AppError("STATE_NOT_ALLOWED");
  // media.link writes a source reference later; prelock the whole file set without a late upgrade.
  const facts = await productionEvidence(tx, deps.media, source.fileId, true, "update"),
    production = facts.production!;
  if (
    facts.file.entityId !== t.entityId ||
    facts.file.storeId !== t.storeId ||
    facts.file.category !== "sample_video" ||
    production.kind !== "sample" ||
    production.orderItemId !== t.orderItemId ||
    production.episodeNo !== 1 ||
    production.variant !== "common" ||
    !facts.durationMs ||
    facts.durationMs !== source.durationMs ||
    facts.playable?.ownerType !== "order_item" ||
    facts.playable.ownerId !== t.orderItemId ||
    facts.playable.entityId !== t.entityId ||
    facts.playable.storeId !== t.storeId
  )
    throw new AppError("FILE_NOT_USABLE", {
      details: { fileIds: [source.fileId], reason: "context_mismatch" },
    });
  const q = await quality(tx, "qc.sample", input.quality, production.aigcState, true),
    now = deps.clock.now();
  // Reuse the verified artifact and its real upload provenance; recovery is recorded separately.
  await moveSample(tx, deps, ctx, t, source, "sample.superseded");
  const sample = await tx.sample.create({
    data: {
      id: uuidv7(),
      entityId: t.entityId,
      storeId: t.storeId,
      deliveryTicketId: t.id,
      versionNo: source.versionNo + 1,
      fileId: source.fileId,
      durationMs: facts.durationMs,
      adSlots: source.adSlots as Prisma.InputJsonValue,
      adVersionsUsed: source.adVersionsUsed as Prisma.InputJsonValue,
      status: "uploaded",
      uploadedByStaffId: source.uploadedByStaffId,
      uploadedAt: source.uploadedAt,
      createdAt: now,
      updatedAt: now,
    },
  });
  await deps.media.link(tx, {
    fileId: source.fileId,
    entityId: t.entityId,
    storeId: t.storeId,
    refType: "sample",
    refId: sample.id,
    role: "main",
  });
  await moveSample(tx, deps, ctx, t, sample, "sample.uploaded", {}, true);
  const qc = await insertQuality(tx, deps, t, staff.staff.id, "sample", sample.id, q);
  await moveSample(tx, deps, ctx, t, sample, "sample.qc_passed", { qc_record_id: qc.id });
  await moveSample(tx, deps, ctx, t, sample, "sample.pushed", {
    pushed_at: now,
    pushed_by_staff_id: staff.staff.id,
    preview_channels: ["weapp"],
  });
  // A same-step migration records the new version without restarting the existing stage or SLA.
  await deps.flow.transition(tx, ctx, {
    machine: "delivery_ticket",
    stateField: "step",
    id: t.id,
    event: "sample.pushed",
    to: "sample_confirm",
    ref: "10:175",
    args: legacySampleRecoveryChecked(),
    meta: sampleAuditMeta(ctx, "cli.q9.sample.recover"),
    entityId: t.entityId,
    storeId: t.storeId,
    set: { current_sample_version_no: sample.versionNo },
    note: reason,
    payload: { sourceSampleId: source.id, sampleId: sample.id, versionNo: sample.versionNo },
    emit: {
      type: "ticket.step_changed",
      payload: {
        v: 1,
        deliveryTicketId: t.id,
        dramaOrderId: t.dramaOrderId,
        orderItemId: t.orderItemId,
        isForced: false,
      },
    },
  });
  await record(tx, ctx.actor, sampleAuditMeta(ctx, "cli.q9.sample.recover"), {
    stream: "activity",
    category: "delivery",
    action: "delivery.sample.legacy_recovered",
    summary: "历史样片重新质检并推送小程序新版本",
    target: { type: "sample", id: sample.id },
    entityId: t.entityId,
    storeId: t.storeId,
    before: {
      sampleId: source.id,
      versionNo: source.versionNo,
      previewChannels: source.previewChannels,
    },
    after: { sampleId: sample.id, versionNo: sample.versionNo, previewChannels: ["weapp"] },
    fields: ["sampleId", "versionNo", "previewChannels"],
    meta: { reason, sourceQcRecordId: source.qcRecordId, qcRecordId: qc.id, fileId: source.fileId },
  });
  await deps.assembly.port(orderSidePort).rederive(tx, { orderItemIds: [t.orderItemId] });
  return sample.id;
}
