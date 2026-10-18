import { IdSchema } from "@liyoxi/contract";
import { lockRows } from "../kernel/index.js";
import type { DeliveredEvent, Tx } from "../kernel/index.js";
import type { NotifyDispatchDeps } from "./context.js";

/** Deletion takes recipient first, excluding every send, then the same fixed channel anchors. */
export async function clearDeletedMerchant(
  tx: Tx,
  deps: NotifyDispatchDeps,
  event: DeliveredEvent,
) {
  const id = IdSchema.parse(event.payload.merchantUserId);
  await deps.merchantTarget(tx, id); // owns merchant80 light lock even when no longer active
  const user = await tx.merchantUser.findUnique({ where: { id }, select: { status: true } });
  if (user?.status !== "deleted") return;
  const identities = await tx.wechatIdentity.findMany({
    where: { merchantUserId: id },
    select: { id: true },
  });
  await lockRows(
    tx,
    "wechat_identity",
    identities.map((row) => row.id),
    "share",
  );
  const rows = await tx.notificationDelivery.findMany({
    where: { notification: { merchantUserId: id } },
    select: { id: true, smsTemplateKey: true, notification: { select: { notifySceneKey: true } } },
    orderBy: { id: "asc" },
  });
  const scenes = await tx.notifyScene.findMany({
    where: {
      sceneKey: {
        in: rows.flatMap((row) => (row.notification ? [row.notification.notifySceneKey] : [])),
      },
    },
    select: { smsTemplateKey: true, wxTemplateSlotKey: true },
  });
  for (const key of [
    ...new Set(
      [
        "verify_code",
        ...rows.map((row) => row.smsTemplateKey),
        ...scenes.map((row) => row.smsTemplateKey),
      ].filter((key): key is string => key !== null),
    ),
  ].sort())
    await tx.$queryRaw`SELECT template_key FROM sms_template WHERE template_key = ${key} FOR UPDATE`;
  for (const key of [
    ...new Set(scenes.flatMap((row) => (row.wxTemplateSlotKey ? [row.wxTemplateSlotKey] : []))),
  ].sort())
    await tx.$queryRaw`SELECT slot_key FROM wx_template_slot WHERE slot_key = ${key} FOR UPDATE`;
  for (const row of rows)
    await tx.$queryRaw`SELECT id FROM notification_delivery WHERE id = ${row.id}::uuid FOR UPDATE`;
  const now = deps.clock.now();
  await tx.notificationDelivery.updateMany({
    where: {
      id: { in: rows.map((row) => row.id) },
      status: { in: ["pending", "sending"] },
      callStartedAt: null,
    },
    data: {
      status: "cancelled",
      reason: "guard_invalid",
      leaseUntil: null,
      finishedAt: now,
      updatedAt: now,
    },
  });
  await tx.notificationDelivery.updateMany({
    where: { id: { in: rows.map((row) => row.id) } },
    data: { targetRef: null, targetMasked: null, updatedAt: now },
  });
  await tx.merchantMessage.deleteMany({ where: { merchantUserId: id } });
  await tx.wxSubscribeQuota.deleteMany({ where: { merchantUserId: id } });
}
