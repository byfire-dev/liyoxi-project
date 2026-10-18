import { chainKey, rowKey } from "../../flow/index.js";
import type { Guard, MachineBinding } from "../../flow/index.js";
import { invoiceReasons } from "./context.js";
const guard: Guard = async (tx, f) => {
  const row = await tx.invoiceRequest.findUnique({
    where: { id: f.subjectId },
    include: { billingOrder: true },
  });
  if (!row || f.entityId !== row.entityId) return false;
  if (f.event === "invoice.request")
    return (
      f.ctx.actor.type === "merchant" &&
      f.ctx.actor.role === "owner" &&
      row.appliedByUserId === f.ctx.actor.id &&
      row.amountFen === row.billingOrder.paidAmountFen &&
      !(await invoiceReasons(tx, row.billingOrder, true)).length &&
      (await tx.entity.findUnique({ where: { id: row.entityId } }))?.verificationStatus ===
        "verified"
    );
  if (f.event === "invoice.issue") {
    const doc = await tx.invoiceDoc.findFirst({
      where: { invoiceRequestId: row.id, docKind: "blue" },
    });
    return (
      f.ctx.actor.type === "staff" &&
      doc?.issuedByStaffId === f.ctx.actor.id &&
      doc.amountFen === row.amountFen &&
      !(await invoiceReasons(tx, row.billingOrder)).length &&
      (row.medium === "electronic"
        ? doc.fileId !== null
        : doc.expressCompany !== null && doc.trackingNo !== null && doc.shippedAt !== null)
    );
  }
  if (f.event === "invoice.issue_red") {
    const docs = await tx.invoiceDoc.findMany({ where: { invoiceRequestId: row.id } }),
      red = docs.find((d) => d.docKind === "red"),
      blue = docs.find((d) => d.docKind === "blue");
    return (
      f.ctx.actor.type === "staff" &&
      !!red &&
      !!blue &&
      red.issuedByStaffId === f.ctx.actor.id &&
      red.originalInvoiceDocId === blue.id &&
      red.amountFen === -blue.amountFen &&
      red.fileId !== null
    );
  }
  if (f.event === "invoice.reject")
    return (
      f.ctx.actor.type === "staff" &&
      (f.args as { reasonValidated?: boolean } | undefined)?.reasonValidated === true
    );
  if (f.event === "invoice.reject_refunded")
    return f.ctx.actor.type === "system" && row.billingOrder.status === "refunded";
  if (f.event === "invoice.cancel_red")
    return (
      f.ctx.actor.type === "system" &&
      (await tx.invoiceDoc.count({ where: { invoiceRequestId: row.id, docKind: "red" } })) === 0
    );
  if (f.event === "sla.recalculated")
    return (
      f.ctx.actor.type === "system" &&
      f.ctx.actor.job === "billing.calendar_imported" &&
      (f.args as { calendarValidated?: boolean } | undefined)?.calendarValidated === true
    );
  return false;
};
export const invoiceMachineBinding: MachineBinding = {
  companions: [
    "reject_kind",
    "reject_reason_code",
    "reject_note",
    "rejected_by_staff_id",
    "rejected_at",
    "due_at",
    "sla_snapshot",
  ],
  guards: Object.fromEntries(
    [
      ["08:1110", "invoice.request"],
      ["08:1111", "invoice.issue"],
      ["08:1112", "invoice.issue"],
      ["08:1113", "invoice.reject"],
      ["08:1114", "invoice.reject_refunded"],
      ["08:1116", "invoice.issue_red"],
      ["08:1117", "invoice.cancel_red"],
      ["08:1133", "sla.recalculated"],
    ].map(([ref, event]) => [rowKey(ref!, event!), guard]),
  ),
};
export const invoiceMachineKey = chainKey("invoice_request", "status");
