import {
  InvoiceRequestCardSchema,
  InvoiceRequestAdminDetailSchema,
  InvoiceRequestAdminRowSchema,
} from "@liyoxi/contract";
import type { InvoiceRequestFilter, AdminInvoiceFilter } from "@liyoxi/contract";
import type { InvoiceRequest, InvoiceDoc, Prisma } from "@liyoxi/db";
import { hasPermission, byEntity } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { staffBrief, entityRef, dictRef } from "../payment/purchase-read.js";
import { invoiceReasons, orderTitle } from "./context.js";
export const activeInvoiceStatuses = ["pending", "issued", "red_pending"];
export async function invoiceInScope(tx: Tx, staff: StaffContext, id: string) {
  const row = await tx.invoiceRequest.findFirst({ where: { id, ...byEntity(staff.scope) } });
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}
export const merchantInvoiceWhere = (
  entityId: string,
  q: InvoiceRequestFilter,
): Prisma.InvoiceRequestWhereInput => ({
  entityId,
  ...(q.paymentOrderId ? { billingOrderId: q.paymentOrderId } : {}),
  ...(q.no ? { requestNo: { contains: q.no, mode: "insensitive" } } : {}),
  ...(q.status ? { status: { in: q.status.split(",") } } : {}),
});
export const adminInvoiceWhere = (
  staff: StaffContext,
  q: AdminInvoiceFilter,
): Prisma.InvoiceRequestWhereInput => ({
  ...byEntity(staff.scope),
  ...(q.invoiceType ? { invoiceType: q.invoiceType } : {}),
  ...(q.medium ? { medium: q.medium } : {}),
  ...(q.q
    ? {
        OR: [
          { requestNo: { contains: q.q, mode: "insensitive" } },
          { billingOrder: { orderNo: { contains: q.q, mode: "insensitive" } } },
          { entity: { name: { contains: q.q, mode: "insensitive" } } },
        ],
      }
    : {}),
});
export async function invoiceDocView(tx: Tx, doc: InvoiceDoc) {
  return {
    docKind: doc.docKind,
    invoiceNo: doc.invoiceNo,
    invoiceCode: doc.invoiceCode,
    amountFen: doc.amountFen,
    issuedAt: doc.issuedAt.toISOString(),
    hasFile: doc.fileId !== null,
    fileFormat: doc.fileFormat,
    expressCompany: await dictRef(tx, "express_company", doc.expressCompany),
    trackingNo: doc.trackingNo,
    shippedAt: doc.shippedAt?.toISOString() ?? null,
    emailState: doc.emailState,
  };
}
async function rejection(tx: Tx, row: InvoiceRequest) {
  return row.status !== "rejected"
    ? null
    : {
        kind: row.rejectKind,
        reason:
          row.rejectKind === "manual"
            ? await dictRef(tx, "reject_reason", row.rejectReasonCode)
            : null,
        note: row.rejectNote,
        rejectedAt: row.rejectedAt!.toISOString(),
      };
}
export async function invoiceCard(tx: Tx, row: InvoiceRequest) {
  const order = await tx.billingOrder.findUniqueOrThrow({ where: { id: row.billingOrderId } }),
    docs = await tx.invoiceDoc.findMany({
      where: { invoiceRequestId: row.id },
      orderBy: { docKind: "asc" },
    }),
    blue = docs.find((d) => d.docKind === "blue");
  const progressNote = row.heldByRefundRequestId
    ? "退款处理中，暂停开具"
    : row.status === "pending"
      ? "财务处理中，开具后通知您"
      : row.status === "rejected"
        ? row.rejectKind === "order_refunded"
          ? "付款单已退款"
          : "申请已驳回，请查看原因"
        : row.status === "red_pending"
          ? "红冲处理中"
          : row.status === "red_issued"
            ? "已红冲"
            : row.medium === "paper"
              ? `已寄出：${(await dictRef(tx, "express_company", blue?.expressCompany ?? null))?.name ?? ""} ${blue?.trackingNo ?? ""}`
              : blue?.emailState === "sent"
                ? `邮件已受理：${row.recvEmailMask ?? ""}`
                : blue?.emailState === "failed"
                  ? "邮件发送失败，可下载发票"
                  : "发票已开具，可下载";
  return InvoiceRequestCardSchema.parse({
    invoiceRequestId: row.id,
    requestNo: row.requestNo,
    paymentOrderId: order.id,
    paymentOrderNo: order.orderNo,
    paymentOrderTitle: orderTitle(order),
    invoiceType: row.invoiceType,
    medium: row.medium,
    itemName: row.itemName,
    status: row.status,
    amountFen: row.amountFen,
    title: row.title,
    taxNoMask: row.taxNoMask,
    recvEmailMask: row.recvEmailMask,
    mailToMask: row.mailToMask,
    appliedAt: row.appliedAt.toISOString(),
    isHeldByRefund: row.heldByRefundRequestId !== null,
    reject: await rejection(tx, row),
    progressNote,
    docs: await Promise.all(docs.map((d) => invoiceDocView(tx, d))),
    actions: [],
  });
}
export async function invoiceAdminRow(tx: Tx, row: InvoiceRequest) {
  const order = await tx.billingOrder.findUniqueOrThrow({ where: { id: row.billingOrderId } }),
    card = await invoiceCard(tx, row);
  return InvoiceRequestAdminRowSchema.parse({
    invoiceRequestId: row.id,
    requestNo: row.requestNo,
    entity: await entityRef(tx, row.entityId),
    paymentOrder: {
      paymentOrderId: order.id,
      orderNo: order.orderNo,
      type: order.type,
      title: orderTitle(order),
    },
    amountFen: row.amountFen,
    invoiceType: row.invoiceType,
    medium: row.medium,
    needsMail: row.medium === "paper",
    status: row.status,
    appliedAt: row.appliedAt.toISOString(),
    dueAt: row.dueAt?.toISOString() ?? null,
    isHeldByRefund: row.heldByRefundRequestId !== null,
    resultNote: row.status === "pending" ? null : card.progressNote,
  });
}
export async function invoiceAdminDetail(tx: Tx, row: InvoiceRequest, staff: StaffContext) {
  const order = await tx.billingOrder.findUniqueOrThrow({ where: { id: row.billingOrderId } }),
    docs = await tx.invoiceDoc.findMany({
      where: { invoiceRequestId: row.id },
      orderBy: { docKind: "asc" },
    }),
    entity = await tx.entity.findUniqueOrThrow({ where: { id: row.entityId } }),
    reasons = await invoiceReasons(tx, order),
    reject = await rejection(tx, row),
    held = row.heldByRefundRequestId
      ? await tx.refundRequest.findUnique({
          where: { id: row.heldByRefundRequestId },
          select: { id: true, approvalRequest: { select: { requestNo: true } } },
        })
      : null;
  return InvoiceRequestAdminDetailSchema.parse({
    ...(await invoiceAdminRow(tx, row)),
    title: row.title,
    taxNoMask: row.taxNoMask,
    addrTelMask: row.addrTelMask,
    bankAccountMask: row.bankAccountMask,
    recvEmailMask: row.recvEmailMask,
    mailToMask: row.mailToMask,
    itemName: row.itemName,
    orderPaidAt: order.paidAt!.toISOString(),
    orderChannel: order.channel,
    prechecks: [
      {
        key: "order_paid_not_refunded",
        passed: !reasons.some((r) => r === "not_paid" || r === "refunded"),
      },
      { key: "no_refund_in_flight", passed: !reasons.includes("refund_in_flight") },
      { key: "title_from_verified_license", passed: entity.verificationStatus === "verified" },
      { key: "not_invoiced_before", passed: !docs.some((d) => d.docKind === "blue") },
      ...(row.invoiceType === "special"
        ? [
            {
              key: "special_fields_filled",
              passed: row.addrTelEnc !== null && row.bankAccountEnc !== null,
            },
          ]
        : []),
    ],
    heldByRefund: held
      ? { refundRequestId: held.id, requestNo: held.approvalRequest.requestNo }
      : null,
    docs: await Promise.all(
      docs.map(async (d) => ({
        ...(await invoiceDocView(tx, d)),
        invoiceDocId: d.id,
        fileId: d.fileId,
        issuedBy: await staffBrief(tx, d.issuedByStaffId),
        emailSentAt: d.emailSentAt?.toISOString() ?? null,
        redReason: d.redReason,
      })),
    ),
    reject: reject ? { ...reject, rejectedBy: await staffBrief(tx, row.rejectedByStaffId) } : null,
    lockVersion: row.lockVersion,
    actions: [
      ...(row.status === "pending" && hasPermission(staff, "finance.invoice.issue")
        ? [...(reasons.length ? [] : ["issue"]), "reject"]
        : []),
      ...(row.status === "red_pending" && hasPermission(staff, "finance.invoice.red")
        ? ["issue-red"]
        : []),
      ...(row.medium === "electronic" &&
      docs.some((d) => d.docKind === "blue" && d.emailState === "failed") &&
      hasPermission(staff, "finance.invoice.issue")
        ? ["resend"]
        : []),
    ],
  });
}
