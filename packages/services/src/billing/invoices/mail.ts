import { formatMoneyFixed } from "@liyoxi/shared/format/money";
import { createHmac } from "node:crypto";
import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { lockRows } from "../../kernel/index.js";
import type { Tx, DeliveredEvent } from "../../kernel/index.js";
import { openField } from "../../security/index.js";
import type { Keyring } from "../../security/index.js";
import type { InvoiceMailSource } from "../../notify/index.js";
/** Owned read port: decrypted fields exist only in the bounded send closure, never notification.vars. */
export async function readInvoiceMail(
  tx: Tx,
  keyring: Keyring,
  invoiceDocId: string,
): Promise<InvoiceMailSource | null> {
  const doc = await tx.invoiceDoc.findUnique({
    where: { id: invoiceDocId },
    include: { invoiceRequest: { include: { billingOrder: true } } },
  });
  if (!doc || doc.docKind !== "blue" || !doc.fileId) return null;
  const row = doc.invoiceRequest;
  if (row.medium !== "electronic" || !row.recvEmailEnc || row.status === "rejected") return null;
  const file = await tx.fileObject.findUnique({ where: { id: doc.fileId } }),
    ref = await tx.fileRef.findFirst({
      where: {
        fileId: doc.fileId,
        refType: "invoice_doc",
        refId: doc.id,
        role: "main",
        state: "live",
      },
    });
  if (
    !file ||
    !ref ||
    file.status !== "stored" ||
    file.moderationState === "block" ||
    file.category !== "invoice" ||
    file.bucket !== "secure" ||
    file.ext !== doc.fileFormat ||
    file.entityId !== row.entityId ||
    !file.etag ||
    file.sizeBytes === null ||
    !["pdf", "ofd", "xml"].includes(file.ext)
  )
    return null;
  const to = openField(keyring, "invoice_request.recv_email_enc", row.recvEmailEnc);
  return {
    invoiceDocId: doc.id,
    invoiceRequestId: row.id,
    billingOrderId: row.billingOrderId,
    entityId: row.entityId,
    to,
    toMask: row.recvEmailMask ?? "****",
    targetRef: createHmac("sha256", keyring.bidxKey("phone"))
      .update("notify.mail\0")
      .update(to.trim().toLowerCase())
      .digest("hex"),
    subject: `【狸有戏】电子发票已开具（付款单 ${row.billingOrder.orderNo}）`,
    text: `抬头：${row.title}\n金额：${formatMoneyFixed(doc.amountFen)}\n发票号码：${doc.invoiceNo}`,
    file: {
      bucket: "secure",
      key: file.objectKey,
      etag: file.etag,
      size: Number(file.sizeBytes),
      ext: file.ext,
      mime: file.mime ?? file.declaredMime,
    },
  };
}
export async function onInvoiceMailResult(tx: Tx, event: DeliveredEvent) {
  if (event.type !== "notify.mail_delivered" && event.type !== "notify.mail_failed") return;
  const payload = EVENT_PAYLOAD_SCHEMAS[event.type].parse(event.payload);
  if (payload.bizType !== "invoice_doc") return;
  const doc = await tx.invoiceDoc.findUnique({
    where: { id: payload.bizId },
    include: { invoiceRequest: true },
  });
  if (!doc || doc.docKind !== "blue") return;
  await lockRows(tx, "billing_order", [doc.invoiceRequest.billingOrderId]);
  await lockRows(tx, "invoice_request", [doc.invoiceRequestId]);
  const delivery = await tx.notificationDelivery.findUnique({
    where: { id: payload.notificationDeliveryId },
    include: { notification: true },
  });
  if (
    !delivery ||
    delivery.channel !== "mail" ||
    delivery.notification?.bizType !== "invoice_doc" ||
    delivery.notification.bizId !== doc.id ||
    delivery.notification.entityId !== doc.entityId ||
    delivery.status !== payload.status ||
    delivery.attemptNo !== payload.attemptNo
  )
    return;
  const latest = await tx.notificationDelivery.findFirst({
    where: { channel: "mail", notificationId: delivery.notificationId },
    orderBy: { resendNo: "desc" },
  });
  if (latest?.id !== delivery.id) return;
  const current = await tx.invoiceDoc.findUniqueOrThrow({ where: { id: doc.id } });
  // Automatic safe retries share one delivery; stale failed results cannot undo a later accepted result.
  if (current.emailState === "sent" && delivery.status !== "sent") return;
  const state =
    delivery.status === "sent" ? "sent" : delivery.status === "skipped" ? "skipped" : "failed";
  await tx.invoiceDoc.update({
    where: { id: doc.id },
    data: {
      emailState: state,
      emailSentAt: state === "sent" ? delivery.sentAt : null,
      updatedAt: delivery.updatedAt,
    },
  });
}
