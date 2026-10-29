import { record as auditRecord } from "../audit/index.js";
import type { SamplePushBody } from "@liyoxi/contract";
import type { Prisma, Sample } from "@liyoxi/db";
import type { StaffContext } from "../authz/index.js";
import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { manualProductionContext } from "./production-context.js";
import { productionEvidence } from "./production-guard.js";
import type { DeliveryDeps, DeliveryViewer } from "./context.js";
import { moveSample } from "./sample-transitions.js";
import { recoverLegacySample } from "./sample-legacy-recovery.js";
import { assertOwner, lockTickets, ticketOf } from "./repo.js";
import type { TicketRow } from "./repo.js";
import { step, reevaluate } from "./reevaluate.js";
import { orderSidePort } from "./ports.js";
import {
  dramaUsesAi,
  invalid,
  insertQuality,
  productionReady,
  quality,
  unpaused,
} from "./quality.js";
import type { QualityInput } from "./quality.js";
export type Slots = Array<{
  slot: "opening" | "ending";
  startMs: number;
  endMs: number;
  label: string;
}>;
export type AdsUsed = Array<{ slot: string; adId: string; versionNo: number }>;
export async function sampleOf(tx: Tx, id: string, subject?: StaffContext | DeliveryViewer) {
  const s = await tx.sample.findUnique({ where: { id } });
  if (!s) throw new AppError("NOT_FOUND");
  const t = await ticketOf(
    tx,
    s.deliveryTicketId,
    subject && "staff" in subject ? subject : undefined,
  );
  if (s.entityId !== t.entityId || s.storeId !== t.storeId) throw new AppError("NOT_FOUND");
  if (
    subject &&
    "membership" in subject &&
    (t.storeId !== subject.membership.storeId || t.entityId !== subject.membership.entityId)
  )
    throw new AppError("NOT_FOUND");
  return { s, t };
}
export async function createSample(
  tx: Tx,
  deps: DeliveryDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  b: { fileId: string; adSlots: Slots },
) {
  // 首次领取空 editor 的事务先用父行范围检查；o 级不能借此读取其他已领取任务。
  const first = await ticketOf(
    tx,
    id,
    staff.moduleLevels.delivery === "o"
      ? { ...staff, moduleLevels: { ...staff.moduleLevels, delivery: "v" } }
      : staff,
  );
  await lockTickets(tx, [id]);
  const t = await ticketOf(tx, id);
  unpaused(t);
  if (t.step !== "sample_making") throw new AppError("STATE_NOT_ALLOWED");
  if (t.editorId && t.editorId !== staff.staff.id) throw new AppError("PERMISSION_DENIED");
  if (first.entityId !== t.entityId || first.storeId !== t.storeId) throw new AppError("NOT_FOUND");
  if (
    b.adSlots.some(
      (r) =>
        !t.orderItem.orderItemPlacements.some((p) => p.slot === r.slot) ||
        r.startMs < 0 ||
        r.endMs <= r.startMs ||
        r.label.length > 20,
    ) ||
    new Set(b.adSlots.map((r) => r.slot)).size !== b.adSlots.length
  )
    throw invalid("adSlots", "广告位标记不合法");
  const old = await tx.sample.findMany({
    where: { deliveryTicketId: id, status: { in: ["uploaded", "qc_passed"] } },
    orderBy: { id: "asc" },
  });
  await lockRows(
    tx,
    "sample",
    old.map((s) => s.id),
  );
  const production = await deps.media.prepareDeliveryProduction(tx, [
    {
      fileId: b.fileId,
      kind: "sample",
      orderItemId: t.orderItemId,
      episodeNo: 1,
      entityId: t.entityId,
      storeId: t.storeId,
      productionTier: t.orderItem.productionModel,
      uploadedByStaffId: staff.staff.id,
      forcedByDrama: await dramaUsesAi(tx, t.orderItem.dramaId),
      ...(await manualProductionContext(tx, t, staff.staff.id, 1)),
    },
  ]);
  const { file, record } = production[0]!;
  const ads: AdsUsed = [];
  for (const p of t.orderItem.orderItemPlacements) {
    const versionId = p.slot === "opening" ? record!.headAdVersionId : record!.tailAdVersionId;
    const v = versionId ? await tx.adVersion.findUnique({ where: { id: versionId } }) : null;
    if (v && v.adId !== p.adId)
      throw new AppError("FILE_NOT_USABLE", {
        details: { fileIds: [b.fileId], reason: "context_mismatch" },
      });
    const no = v?.versionNo ?? p.boundVersionNo ?? p.ad.confirmedVersionNo;
    if (no !== null) ads.push({ slot: p.slot, adId: p.adId, versionNo: no });
  }
  for (const s of old) await moveSample(tx, deps, ctx, t, s, "sample.superseded");
  const max = await tx.sample.aggregate({
      where: { deliveryTicketId: id },
      _max: { versionNo: true },
    }),
    now = deps.clock.now();
  const info = await tx.mediaInfo.findUnique({ where: { fileId: b.fileId } });
  const s = await tx.sample.create({
    data: {
      id: uuidv7(),
      entityId: t.entityId,
      storeId: t.storeId,
      deliveryTicketId: id,
      versionNo: (max._max.versionNo ?? 0) + 1,
      fileId: file!.id,
      durationMs: info?.durationMs ?? null,
      adSlots: b.adSlots,
      adVersionsUsed: ads as Prisma.InputJsonValue,
      status: "uploaded",
      uploadedByStaffId: staff.staff.id,
      uploadedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  if (!t.editorId) {
    await tx.deliveryTicket.update({
      where: { id },
      data: { editorId: staff.staff.id, updatedAt: now },
    });
    await auditRecord(
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
        action: "delivery.ticket.editor_claimed",
        summary: "首次登记领取剪辑任务",
        target: { type: "delivery_ticket", id },
        entityId: t.entityId,
        storeId: t.storeId,
        before: { editorId: null },
        after: { editorId: staff.staff.id },
        fields: ["editorId"],
      },
    );
  }
  await deps.media.link(tx, {
    fileId: b.fileId,
    entityId: t.entityId,
    storeId: t.storeId,
    refType: "sample",
    refId: s.id,
    role: "main",
  });
  await moveSample(tx, deps, ctx, t, s, "sample.uploaded", {}, true);
  await reevaluate(tx, deps, ctx, t.id);
  return s.id;
}
export async function inspectSample(
  tx: Tx,
  deps: DeliveryDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  b: QualityInput,
) {
  const first = await sampleOf(tx, id, staff);
  await lockTickets(tx, [first.t.id]);
  await lockRows(tx, "sample", [id]);
  const { s, t } = await sampleOf(tx, id, staff);
  unpaused(t);
  if (t.step !== "sample_making" || s.status !== "uploaded")
    throw new AppError("STATE_NOT_ALLOWED");
  if (s.uploadedByStaffId === staff.staff.id) throw new AppError("QC_SELF_INSPECTION");
  await lockRows(tx, "production_record", [s.fileId], "share");
  await lockRows(tx, "file_object", [s.fileId], "share");
  const info = await tx.mediaInfo.findUnique({ where: { fileId: s.fileId } }),
    duration = s.durationMs ?? info?.durationMs ?? null;
  if (!duration || duration <= 0)
    throw new AppError("PRODUCTION_NOT_READY", {
      details: {
        fileId: s.fileId,
        pipelineState:
          (await tx.productionRecord.findUnique({ where: { fileId: s.fileId } }))?.pipelineState ??
          "missing",
        gate: null,
      },
    });
  const p = await productionReady(tx, s.fileId, deps.media),
    q = await quality(tx, "qc.sample", b, p.aigcState),
    r = await insertQuality(tx, deps, t, staff.staff.id, "sample", id, q);
  await moveSample(
    tx,
    deps,
    ctx,
    t,
    s,
    q.verdict === "pass" ? "sample.qc_passed" : "sample.qc_failed",
    { qc_record_id: r.id, duration_ms: duration },
  );
  await reevaluate(tx, deps, ctx, t.id);
}
export async function pushSample(
  tx: Tx,
  deps: DeliveryDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  b: SamplePushBody,
) {
  const first = await sampleOf(tx, id, staff);
  await lockRows(
    tx,
    "ad",
    (first.s.adVersionsUsed as AdsUsed).map((a) => a.adId),
    "share",
  );
  await lockTickets(tx, [first.t.id]);
  await lockRows(tx, "sample", [id]);
  const { s, t } = await sampleOf(tx, id, staff);
  unpaused(t);
  if (!b.legacyRecovery && (t.step !== "sample_making" || s.status !== "qc_passed"))
    throw new AppError("STATE_NOT_ALLOWED");
  const ads = s.adVersionsUsed as AdsUsed,
    changed: string[] = [];
  for (const p of t.orderItem.orderItemPlacements) {
    const used = ads.find((a) => a.slot === p.slot && a.adId === p.adId),
      ad = await tx.ad.findUnique({ where: { id: p.adId } });
    if (!used || ad?.status !== "confirmed" || ad.confirmedVersionNo !== used.versionNo)
      changed.push(p.adId);
  }
  if (changed.length)
    throw new AppError("AD_CHANGED", { details: { adIds: [...new Set(changed)] } });
  if (b.includeWecom || b.markWecomSent)
    throw invalid("includeWecom", "第一期样片仅支持在小程序内查看");
  if (!(await deps.samplePlayback?.(t.entityId))) throw new AppError("FEATURE_DISABLED");
  if (b.legacyRecovery) return recoverLegacySample(tx, deps, ctx, staff, t, s, b.legacyRecovery);
  await productionEvidence(tx, deps.media, s.fileId, true);
  const now = deps.clock.now();
  await moveSample(tx, deps, ctx, t, s, "sample.pushed", {
    pushed_at: now,
    pushed_by_staff_id: staff.staff.id,
    preview_channels: ["weapp"],
  });
  await step(tx, deps, ctx, t, "sample.pushed", "sample_confirm", "10:175", {
    current_sample_version_no: s.versionNo,
    sample_first_pushed_at: t.sampleFirstPushedAt ?? now,
    waiting_on: "merchant",
  });
  await deps.assembly.port(orderSidePort).rederive(tx, { orderItemIds: [t.orderItemId] });
  return s.id;
}
export async function sampleEvidence(tx: Tx, deps: DeliveryDeps, t: TicketRow, s: Sample) {
  const rows = await tx.auditLog.findMany({
    where: {
      stream: "access",
      targetType: "sample",
      targetId: s.id,
      action: { in: ["delivery.sample.album_download", "delivery.sample.portal_preview"] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const album = rows.find((r) => r.action === "delivery.sample.album_download")?.createdAt ?? null,
    portal = rows.find((r) => r.action === "delivery.sample.portal_preview")?.createdAt ?? null,
    enabled = (await deps.samplePlayback?.(t.entityId)) ?? false;
  const production = await deps.media.deliveryProductionFacts(tx, s.fileId);
  const possible =
    enabled && s.previewChannels.includes("weapp") && production.ready && production.playable
      ? ["weapp"]
      : [];
  return { album, portal, enabled, possible, production };
}
export async function confirmSample(
  tx: Tx,
  deps: DeliveryDeps,
  viewer: DeliveryViewer,
  id: string,
  b: { versionNo: number; viewedVia: string; hasViewed: boolean },
) {
  assertOwner(viewer);
  const first = await sampleOf(tx, id, viewer);
  await lockRows(
    tx,
    "ad",
    (first.s.adVersionsUsed as AdsUsed).map((a) => a.adId),
    "share",
  );
  await lockTickets(tx, [first.t.id]);
  await lockRows(tx, "sample", [id]);
  const { s, t } = await sampleOf(tx, id, viewer);
  unpaused(t);
  if (b.versionNo !== s.versionNo || s.versionNo !== t.currentSampleVersionNo)
    throw new AppError("SAMPLE_VERSION_STALE", {
      details: {
        currentVersionNo: t.currentSampleVersionNo,
        currentSampleId:
          (
            await tx.sample.findUnique({
              where: {
                deliveryTicketId_versionNo: {
                  deliveryTicketId: t.id,
                  versionNo: t.currentSampleVersionNo ?? 0,
                },
              },
            })
          )?.id ?? null,
      },
    });
  if (s.status !== "pushed" || t.step !== "sample_confirm") throw new AppError("STATE_NOT_ALLOWED");
  if (b.viewedVia !== "weapp" || !s.previewChannels.includes("weapp"))
    throw new AppError("SAMPLE_VIEW_CHANNEL_NOT_OFFERED", {
      details: { previewChannels: s.previewChannels },
    });
  const changed: string[] = [];
  for (const a of s.adVersionsUsed as AdsUsed) {
    const ad = await tx.ad.findUnique({ where: { id: a.adId } });
    if (ad?.status !== "confirmed" || ad.confirmedVersionNo !== a.versionNo) changed.push(a.adId);
  }
  if (changed.length)
    throw new AppError("AD_CHANGED", { details: { adIds: [...new Set(changed)] } });
  if (!(await deps.samplePlayback?.(t.entityId))) throw new AppError("FEATURE_DISABLED");
  if (b.hasViewed !== true) throw invalid("hasViewed", "请先勾选‘我已查看’");
  await productionEvidence(tx, deps.media, s.fileId, true);
  const now = deps.clock.now();
  await moveSample(tx, deps, viewer.ctx, t, s, "sample.confirmed", {
    decided_at: now,
    decided_by_user_id: viewer.ctx.actor.id,
    decide_client: viewer.ctx.actor.client,
    confirm_viewed_via: b.viewedVia,
    ...(b.hasViewed ? { viewed_ack_at: now, viewed_ack_by_user_id: viewer.ctx.actor.id } : {}),
  });
  for (const a of s.adVersionsUsed as AdsUsed)
    await tx.orderItemPlacement.updateMany({
      where: { orderItemId: t.orderItemId, slot: a.slot, adId: a.adId, boundVersionNo: null },
      data: { boundVersionNo: a.versionNo, pinnedAt: now, updatedAt: now },
    });
  await step(tx, deps, viewer.ctx, t, "sample.confirmed", "batch_compose", "10:176", {
    sample_confirmed_at: t.sampleConfirmedAt ?? now,
  });
  await deps.assembly.port(orderSidePort).rederive(tx, { orderItemIds: [t.orderItemId] });
}
