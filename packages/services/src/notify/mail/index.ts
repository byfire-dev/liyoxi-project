import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { AppError, uuidv7, createIdentityContext } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { NotificationDelivery, Notification } from "@liyoxi/db";
import type { InvoiceMailSource, NotifyDispatchDeps } from "../context.js";
import type { NotificationProviderResult } from "../../providers/types.js";
export async function invoiceMailResult(
  tx: Tx,
  deps: NotifyDispatchDeps,
  delivery: NotificationDelivery,
  notification: Notification | null,
) {
  if (
    delivery.channel !== "mail" ||
    notification?.bizType !== "invoice_doc" ||
    !notification.bizId ||
    !["sent", "failed", "skipped", "cancelled"].includes(delivery.status)
  )
    return;
  if (!deps.events) throw new AppError("INTERNAL");
  const ctx = createIdentityContext({
    actor: { type: "system", job: "notify.mail" },
    entityId: notification.entityId,
    storeId: null,
  });
  const payload = {
    v: 1 as const,
    notificationDeliveryId: delivery.id,
    bizType: "invoice_doc" as const,
    bizId: notification.bizId,
    attemptNo: delivery.attemptNo,
    status: delivery.status as "sent" | "failed" | "skipped" | "cancelled",
  };
  await deps.events.emit(tx, ctx, {
    type: delivery.status === "sent" ? "notify.mail_delivered" : "notify.mail_failed",
    aggregate: { type: "notification_delivery", id: delivery.id },
    payload:
      delivery.status === "sent"
        ? EVENT_PAYLOAD_SCHEMAS["notify.mail_delivered"].parse({ ...payload, status: "sent" })
        : EVENT_PAYLOAD_SCHEMAS["notify.mail_failed"].parse({
            ...payload,
            reason: delivery.reason ?? "provider_rejected",
          }),
    entityId: notification.entityId,
    dedupeKey: `notify.mail:${delivery.id}:${delivery.attemptNo}:${delivery.status}`,
  });
}
export function mailSend(deps: NotifyDispatchDeps, source: InvoiceMailSource) {
  return async (signal: AbortSignal): Promise<NotificationProviderResult<unknown>> => {
    signal.throwIfAborted();
    if (source.file.size <= 0 || source.file.size > 4 * 1024 * 1024)
      return {
        ok: false,
        reason: "rejected",
        message: "发票附件超过邮件限制",
        notification: { acceptance: "not_accepted", code: "provider_rejected" },
      };
    const read = await deps.providers.storage.readObject({
      bucket: source.file.bucket,
      key: source.file.key,
      maxBytes: 4 * 1024 * 1024,
      ifMatchEtag: source.file.etag,
      signal,
    });
    if (!read.ok)
      return {
        ok: false,
        reason: read.reason,
        message: "发票附件暂不可读取",
        notification: { acceptance: "not_accepted", code: "aborted" },
      };
    if (read.value.byteLength !== source.file.size)
      return {
        ok: false,
        reason: "rejected",
        message: "发票附件长度不一致",
        notification: { acceptance: "not_accepted", code: "provider_rejected" },
      };
    signal.throwIfAborted();
    return deps.providers.mail.send({
      to: source.to,
      subject: source.subject,
      text: source.text,
      attachments: [
        {
          filename: `invoice-${source.invoiceDocId}.${source.file.ext}`,
          contentType: source.file.mime,
          content: read.value,
        },
      ],
      signal,
    });
  };
}
/** Only this existing notification gets another delivery; invoice parent lock serializes concurrent requests. */
export async function resendInvoiceMail(
  tx: Tx,
  deps: Pick<NotifyDispatchDeps, "clock">,
  invoiceDocId: string,
) {
  const notifications = await tx.notification.findMany({
    where: { bizType: "invoice_doc", bizId: invoiceDocId, notifySceneKey: "m.invoice_issued" },
    orderBy: { createdAt: "asc" },
  });
  // A legal invoice sends its one explicit email once, independent of how many owners receive inbox messages.
  const original = await tx.notificationDelivery.findFirst({
    where: { notificationId: { in: notifications.map((n) => n.id) }, channel: "mail" },
    orderBy: [{ createdAt: "desc" }, { resendNo: "desc" }],
  });
  if (!original?.notificationId || original.status !== "failed")
    throw new AppError("STATE_NOT_ALLOWED");
  const latest = await tx.notificationDelivery.findFirst({
    where: { notificationId: original.notificationId, channel: "mail" },
    orderBy: { resendNo: "desc" },
  });
  if (latest?.id !== original.id) throw new AppError("STATE_NOT_ALLOWED");
  const now = deps.clock.now();
  const cfg = await tx.notifyScene.findUnique({ where: { sceneKey: "m.invoice_issued" } });
  if (!cfg?.sceneEnabled || !cfg.extEnabled)
    throw new AppError("NOTIFY_RESEND_NOT_ALLOWED", { details: { reason: "scene_disabled" } });
  if (original.resendNo >= 32767) throw new AppError("STATE_NOT_ALLOWED");
  await tx.notificationDelivery.create({
    data: {
      id: uuidv7(),
      notificationId: original.notificationId,
      channel: "mail",
      origin: "manual",
      resendNo: original.resendNo + 1,
      status: "pending",
      dueAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
}
