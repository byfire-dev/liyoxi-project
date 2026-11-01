import { AdminSampleRequestChangeBodySchema } from "@liyoxi/contract";
import type { AdminSampleRequestChangeBody } from "@liyoxi/contract";
import { assertAccess, assertPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { paramsAt } from "../config/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { lockCalendarImport } from "../sla/index.js";
import {
  readAdDeliveryImpact,
  lockAdDeliveryImpact,
  applyAdDeliveryImpact,
} from "./ad-delivery-impact.js";
import type { DeliveryDeps } from "./context.js";
import { prepareReevaluation } from "./reevaluate-locks.js";
import { currentSample, stale, writeSampleFeedback } from "./sample-feedback.js";
import { sampleOf } from "./samples.js";
import type { AdsUsed } from "./samples.js";
import { unpaused } from "./quality.js";
import { productionEvidence } from "./production-guard.js";

export async function adminRequestSampleChange(
  tx: Tx,
  deps: DeliveryDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  input: AdminSampleRequestChangeBody,
) {
  const body = AdminSampleRequestChangeBodySchema.parse(input);
  if (ctx.actor.type !== "staff" || ctx.actor.id !== staff.staff.id || ctx.actor.client !== "admin")
    throw new AppError("PERMISSION_DENIED");
  assertAccess(staff, { module: { module: "delivery", need: "view" }, permission: null });
  assertPermission(staff, "delivery.sample.feedback_on_behalf", deps.clock.now());
  const first = await sampleOf(tx, id, staff),
    fileIds = body.feedbackFileIds ?? [];
  if (
    body.feedbackKind === "ad_content" &&
    !(first.s.adVersionsUsed as AdsUsed).some((ad) => ad.adId === body.adId)
  )
    throw new AppError("AD_CHANGED", { details: { adIds: [body.adId] } });
  if (body.feedbackKind === "ad_content" && (!deps.adOrderReferences || !deps.reopenAdFree))
    throw new AppError("INTERNAL", { message: "广告反馈真实组合尚未装配" });
  const impact =
    body.feedbackKind === "ad_content"
      ? await readAdDeliveryImpact(
          tx,
          { entityId: first.t.entityId, storeId: first.t.storeId, adId: body.adId, mode: "reopen" },
          deps.adOrderReferences!,
        )
      : null;
  if (impact) await lockAdDeliveryImpact(tx, impact, { staffIds: [staff.staff.id], fileIds });
  else {
    await lockCalendarImport(tx);
    await prepareReevaluation(tx, [first.t.id], { staffIds: [staff.staff.id], fileIds });
  }
  const actor = await tx.staff.findUnique({ where: { id: staff.staff.id } });
  if (
    !actor ||
    actor.status !== "active" ||
    actor.staffRoleKey !== staff.staff.roleKey ||
    actor.isLead !== staff.staff.isLead
  )
    throw new AppError("PERMISSION_DENIED");
  const { s, t } = await sampleOf(tx, id, staff);
  unpaused(t);
  await currentSample(tx, t, s);
  if (s.versionNo !== body.versionNo || s.versionNo !== t.currentSampleVersionNo)
    await stale(tx, t);
  if (s.status !== "pushed" || t.step !== "sample_confirm") throw new AppError("STATE_NOT_ALLOWED");
  await productionEvidence(tx, deps.media, s.fileId, true);
  if (body.feedbackKind === "ad_content" && !impact!.ticketIds.includes(t.id))
    throw new AppError("AD_CHANGED", {
      details: { adIds: [body.adId] },
    });
  // Staff screenshots must belong to the real submitting staff and this same store.
  await lockRows(tx, "file_object", fileIds);
  for (const fileId of fileIds) {
    const file = await tx.fileObject.findUnique({ where: { id: fileId } });
    if (
      !file ||
      file.category !== "ticket_attachment" ||
      file.scopeType !== "store" ||
      file.entityId !== t.entityId ||
      file.storeId !== t.storeId ||
      file.uploadActorType !== "staff" ||
      file.uploadActorId !== staff.staff.id
    )
      throw new AppError("FILE_NOT_USABLE", {
        details: { fileIds: [fileId], reason: "scope_mismatch" },
      });
    await deps.media.link(tx, {
      fileId,
      entityId: t.entityId,
      storeId: t.storeId,
      refType: "sample",
      refId: s.id,
      role: "feedback",
    });
  }
  if (body.feedbackKind === "ad_content") {
    const used = (s.adVersionsUsed as AdsUsed).find((ad) => ad.adId === body.adId);
    if (!used) throw new AppError("AD_CHANGED", { details: { adIds: [body.adId] } });
    const params = await paramsAt(tx, ["ad.revision_screenshot_max"], deps.clock.now());
    await deps.reopenAdFree!(
      tx,
      { ctx, staff },
      {
        adId: body.adId,
        onVersionNo: used.versionNo,
        note: body.note,
        // The sample retains every feedback attachment; the ad revision takes the first
        // configured number in request order under its separate screenshot limit.
        screenshotFileIds: fileIds.slice(0, params["ad.revision_screenshot_max"]),
      },
    );
  }
  await writeSampleFeedback(tx, deps, ctx, t, s, {
    kind: body.feedbackKind,
    note: body.note,
    fileIds,
    staffId: staff.staff.id,
    ...(body.feedbackTimeMs === undefined ? {} : { timeMs: body.feedbackTimeMs }),
  });
  if (impact) await applyAdDeliveryImpact(tx, deps, ctx, impact);
  return s.id;
}
