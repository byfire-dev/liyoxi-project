import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { AdStaffActor, AdWriteDeps } from "./context.js";
import { moveAd, noCancel } from "./lifecycle.js";
import { requireAdProductionAccess } from "./production-parent-facts.js";
import { storeGate } from "../profile/index.js";
import { assertAccess } from "../authz/index.js";
import { readCancelHoldFacts } from "../billing/index.js";

/** Shared legal producer for M5-08 acceptance and M5-09; no HTTP or SLA consumer lives here. */
export async function assignAdTx(
  tx: Tx,
  deps: AdWriteDeps,
  actor: AdStaffActor,
  adId: string,
  editorId: string,
) {
  assertAccess(actor.staff, {
    module: { module: "delivery", need: "edit" },
    permission: "delivery.ad.assign",
  });
  const initial = await tx.ad.findUnique({ where: { id: adId } });
  if (!initial) throw new AppError("NOT_FOUND");
  await lockRows(tx, "staff", [...new Set([actor.staff.staff.id, editorId])], "share");
  await lockRows(tx, "entity", [initial.entityId]);
  await lockRows(tx, "store", [initial.storeId]);
  await lockRows(tx, "ad", [adId]);
  await requireAdProductionAccess(tx, { identity: actor.ctx, staff: actor.staff }, adId);
  const ad = await tx.ad.findUniqueOrThrow({ where: { id: adId } });
  noCancel(ad);
  if (ad.status !== "pending_assign") throw new AppError("STATE_NOT_ALLOWED");
  if ((await storeGate(tx, ad.storeId)) !== "full") throw new AppError("AD_WAITING_QUALIFICATION");
  const editor = await tx.staff.findUnique({ where: { id: editorId } });
  if (
    !editor ||
    editor.status !== "active" ||
    editor.staffRoleKey !== "editor" ||
    (actor.staff.scope.kind !== "all" && !actor.staff.scope.staffIds.includes(editorId))
  )
    throw new AppError("ASSIGNEE_INVALID");
  const store = await tx.store.findUniqueOrThrow({
    where: { id: ad.storeId },
    include: { entity: true },
  });
  if (store.lifecycle !== "active" || store.entity.lifecycle !== "active")
    throw new AppError("STATE_NOT_ALLOWED");
  const captured = await deps.ledger.capture(tx, {
    pointHoldId: ad.pointHoldId,
    title: { refType: "ad", refNo: ad.adNo, count: 1 },
    ctx: actor.ctx,
  });
  const hold = await readCancelHoldFacts(tx, captured.pointHoldId);
  if (
    !hold?.capturedAt ||
    hold.entityId !== ad.entityId ||
    hold.storeId !== ad.storeId ||
    hold.refType !== "ad" ||
    hold.refId !== ad.id ||
    hold.qty !== ad.chargePoints
  )
    throw new AppError("PRECONDITION_CHANGED");
  await moveAd(
    tx,
    deps,
    actor.ctx,
    ad,
    "ad.assign",
    "09:802",
    { editor_id: editorId, captured_at: hold.capturedAt },
    { type: "ad.assigned", payload: { v: 1, adId, editorId } },
  );
  return adId;
}
export interface RegisterAdVersionInput {
  fileId: string;
  durationMs: number;
  width: number;
  height: number;
  segments: readonly { index: number; fromMs: number; toMs: number; label: string }[];
}
export async function registerAdVersionTx(
  tx: Tx,
  deps: AdWriteDeps,
  actor: AdStaffActor,
  adId: string,
  body: RegisterAdVersionInput,
) {
  assertAccess(actor.staff, {
    module: { module: "delivery", need: "edit" },
    permission: "delivery.ad.upload",
  });
  await lockRows(tx, "ad", [adId]);
  await requireAdProductionAccess(tx, { identity: actor.ctx, staff: actor.staff }, adId);
  const ad = await tx.ad.findUniqueOrThrow({ where: { id: adId } });
  noCancel(ad);
  if (!["producing", "revising"].includes(ad.status)) throw new AppError("STATE_NOT_ALLOWED");
  if (ad.editorId !== actor.staff.staff.id) throw new AppError("NOT_FOUND");
  await lockRows(tx, "file_object", [body.fileId]);
  const production = await deps.media.adProductionFacts(tx, body.fileId);
  if (
    !production.ready ||
    production.production?.adId !== ad.id ||
    production.file.entityId !== ad.entityId ||
    production.file.storeId !== ad.storeId
  )
    throw new AppError("PRODUCTION_NOT_READY");
  if (
    body.width !== 1080 ||
    body.height !== 1920 ||
    Math.abs(body.durationMs - ad.durationSec * 1000) > 200 ||
    production.durationMs !== body.durationMs
  )
    throw new AppError("AD_VERSION_SPEC_INVALID");
  if (
    new Set(body.segments.map((s) => s.index)).size !== body.segments.length ||
    body.segments.some(
      (s) =>
        !Number.isInteger(s.index) ||
        s.index < 0 ||
        s.fromMs < 0 ||
        s.toMs <= s.fromMs ||
        s.toMs > body.durationMs,
    )
  )
    throw new AppError("AD_VERSION_SPEC_INVALID");
  const now = deps.clock.now(),
    id = uuidv7(),
    versionNo = ad.latestVersionNo + 1;
  await deps.media.link(tx, {
    fileId: body.fileId,
    entityId: ad.entityId,
    storeId: ad.storeId,
    refType: "ad_version",
    refId: id,
    role: "main",
  });
  await tx.adVersion.create({
    data: {
      id,
      adId,
      entityId: ad.entityId,
      storeId: ad.storeId,
      versionNo,
      fileId: body.fileId,
      durationMs: body.durationMs,
      width: body.width,
      height: body.height,
      segments: [...body.segments],
      uploadedByStaffId: actor.staff.staff.id,
      uploadedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  await tx.ad.update({
    where: { id: adId },
    data: { latestVersionNo: versionNo, lockVersion: { increment: 1 }, updatedAt: now },
  });
  return { adId, adVersionId: id, versionNo };
}
export async function pushAdVersionTx(
  tx: Tx,
  deps: AdWriteDeps,
  actor: AdStaffActor,
  adVersionId: string,
) {
  assertAccess(actor.staff, {
    module: { module: "delivery", need: "edit" },
    permission: "delivery.ad.upload",
  });
  const initial = await tx.adVersion.findUnique({ where: { id: adVersionId } });
  if (!initial) throw new AppError("NOT_FOUND");
  await lockRows(tx, "ad", [initial.adId]);
  await requireAdProductionAccess(tx, { identity: actor.ctx, staff: actor.staff }, initial.adId);
  const ad = await tx.ad.findUniqueOrThrow({ where: { id: initial.adId } });
  noCancel(ad);
  if (ad.editorId !== actor.staff.staff.id) throw new AppError("PERMISSION_DENIED");
  const version = await tx.adVersion.findUniqueOrThrow({ where: { id: adVersionId } });
  if (
    ad.latestVersionNo !== version.versionNo ||
    !["producing", "revising"].includes(ad.status) ||
    version.pushedAt ||
    version.decision
  )
    throw new AppError("STATE_NOT_ALLOWED");
  await lockRows(tx, "file_object", [version.fileId]);
  const production = await deps.media.adProductionFacts(tx, version.fileId);
  if (!production.ready || production.production?.adId !== ad.id)
    throw new AppError("PRODUCTION_NOT_READY");
  const enabled = await deps.playback(ad.entityId);
  if (enabled && !production.playable) throw new AppError("PRODUCTION_NOT_READY");
  const channels = enabled ? ["weapp"] : ["album", "portal"],
    now = deps.clock.now();
  await tx.adVersion.updateMany({
    where: { adId: ad.id, versionNo: { lt: version.versionNo }, decision: null },
    data: { decision: "superseded", decidedAt: now, updatedAt: now },
  });
  await tx.adVersion.update({
    where: { id: version.id },
    data: { pushedAt: now, previewChannels: channels, updatedAt: now },
  });
  await tx.adRevision.updateMany({
    where: { adId: ad.id, fulfilledByVersionNo: null },
    data: { fulfilledByVersionNo: version.versionNo, updatedAt: now },
  });
  await deps.timers.cancel(tx, { subject: { type: "ad", id: ad.id }, kinds: ["sla.breach"] });
  await moveAd(
    tx,
    deps,
    actor.ctx,
    ad,
    "ad.push_version",
    "09:805",
    { due_at: null, sla_snapshot: null },
    {
      type: "ad.version_pushed",
      payload: { v: 1, adId: ad.id, versionNo: version.versionNo, previewChannels: channels },
    },
    { versionNo: version.versionNo },
  );
  return { adId: ad.id, adVersionId: version.id, versionNo: version.versionNo };
}
