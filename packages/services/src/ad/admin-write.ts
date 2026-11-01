import { calendarDate, addDays } from "@liyoxi/shared/time";
import { record } from "../audit/index.js";
import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { AdStaffActor } from "./context.js";
import { adAdminTarget, assertAdStaff, assertCurrentAdStaff, canRemindAd } from "./admin-read.js";
import type { AdAdminReadDeps } from "./admin-read.js";
import { noCancel } from "./lifecycle.js";

/** No low-ranked target may be added after the first account or file lock. */
export async function prelockAdminAdTx(
  tx: Tx,
  actor: AdStaffActor,
  adId: string,
  staffIds: readonly string[] = [],
) {
  const initial = await adAdminTarget(tx, actor, adId);
  await lockRows(tx, "staff", [actor.staff.staff.id, ...staffIds], "share");
  await assertCurrentAdStaff(tx, actor);
  await lockRows(tx, "entity", [initial.entityId]);
  await lockRows(tx, "store", [initial.storeId]);
  await lockRows(tx, "ad", [adId]);
  return adAdminTarget(tx, actor, adId);
}
export async function markAdVersionSentTx(
  tx: Tx,
  deps: AdAdminReadDeps,
  actor: AdStaffActor,
  adVersionId: string,
) {
  assertAdStaff(actor, "delivery.sample.push", true);
  const initial = await tx.adVersion.findUnique({
    where: { id: adVersionId },
    select: { adId: true },
  });
  if (!initial) throw new AppError("NOT_FOUND");
  const ad = await prelockAdminAdTx(tx, actor, initial.adId);
  noCancel(ad);
  const version = await tx.adVersion.findUniqueOrThrow({ where: { id: adVersionId } });
  if (ad.status === "cancelled" || version.decision !== null)
    throw new AppError("STATE_NOT_ALLOWED");
  if (!version.offlineSentAt) {
    const now = deps.clock.now();
    await tx.adVersion.update({
      where: { id: adVersionId },
      data: { offlineSentAt: now, offlineSentByStaffId: actor.staff.staff.id, updatedAt: now },
    });
    await record(
      tx,
      actor.ctx.actor,
      {
        requestId: actor.ctx.requestId,
        ip: actor.ctx.ip,
        userAgent: actor.ctx.userAgent,
        sessionId: null,
        authMethod: null,
      },
      {
        stream: "ops",
        category: "delivery",
        action: "ad.version.mark_sent",
        summary: "登记广告已由企业微信发送",
        target: { type: "ad_version", id: adVersionId },
        entityId: ad.entityId,
        storeId: ad.storeId,
        meta: { adId: ad.id, versionNo: version.versionNo },
      },
    );
  }
  return { adId: ad.id, adVersionId };
}
export async function remindAdminAdTx(
  tx: Tx,
  deps: AdAdminReadDeps,
  actor: AdStaffActor,
  adId: string,
) {
  assertAdStaff(actor);
  const ad = await prelockAdminAdTx(tx, actor, adId);
  noCancel(ad);
  const related = await deps.relations(tx, actor, ad);
  if (!canRemindAd(actor, ad, related.deliveryManagerId)) throw new AppError("PERMISSION_DENIED");
  const version = await tx.adVersion.findFirst({
    where: { adId, pushedAt: { not: null }, decision: null },
    orderBy: { versionNo: "desc" },
  });
  if (ad.status !== "pending_confirm" || !version || version.versionNo !== ad.latestVersionNo)
    throw new AppError("REMIND_NOT_APPLICABLE");
  const now = deps.clock.now(),
    bizDate = calendarDate(now),
    nextAvailableDate = addDays(bizDate, 1),
    logId = uuidv7();
  const made = await tx.manualReminderLog.createMany({
    data: {
      id: logId,
      subjectType: "ad",
      subjectId: adId,
      scene: "confirm_ad",
      bizDate: new Date(bizDate),
      sentByStaffId: actor.staff.staff.id,
      createdAt: now,
    },
    skipDuplicates: true,
  });
  if (!made.count)
    throw new AppError("REMINDED_TODAY", { details: { scene: "confirm_ad", nextAvailableDate } });
  await deps.events.emit(tx, actor.ctx, {
    type: "manual_reminder.sent",
    aggregate: { type: "manual_reminder_log", id: logId },
    entityId: ad.entityId,
    storeId: ad.storeId,
    payload: {
      v: 1,
      manualReminderLogId: logId,
      subjectType: "ad",
      subjectId: adId,
      scene: "confirm_ad",
      bizDate,
    },
  });
  await record(
    tx,
    actor.ctx.actor,
    {
      requestId: actor.ctx.requestId,
      ip: actor.ctx.ip,
      userAgent: actor.ctx.userAgent,
      sessionId: null,
      authMethod: null,
    },
    {
      stream: "activity",
      category: "delivery",
      action: "ad.task.remind",
      summary: "人工催办商家确认广告",
      target: { type: "ad", id: adId },
      entityId: ad.entityId,
      storeId: ad.storeId,
      meta: { scene: "confirm_ad", manualReminderLogId: logId },
    },
  );
  return {
    scene: "confirm_ad" as const,
    subjectType: "ad" as const,
    subjectId: adId,
    remindedAt: now.toISOString(),
    nextAvailableDate,
  };
}
