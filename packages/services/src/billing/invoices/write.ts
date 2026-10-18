import { InvoiceMediumSchema } from "@liyoxi/contract";
import type {
  InvoiceRequestCreateBody,
  InvoiceIssueBody,
  InvoiceIssueRedBody,
  InvoiceRejectBody,
} from "@liyoxi/contract";
import type { InvoiceRequest } from "@liyoxi/db";
import { AppError, lockRows, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import type { StaffContext } from "../../authz/index.js";
import { encryptField, openField } from "../../security/index.js";
import { maskEmail, maskName, maskPhone, maskBankAccount } from "@liyoxi/shared/mask";
import { paramsAt } from "../../config/index.js";
import { workHoursAt } from "../../sla/index.js";
import { assertFinanceStaff } from "../finance-config/service.js";
import { invoiceCard, invoiceAdminDetail, invoiceInScope, activeInvoiceStatuses } from "./read.js";
import { assertInvoiceOwner, invoiceReasons } from "./context.js";
import type { InvoiceDeps } from "./context.js";
import type { PurchaseActor } from "../payment/purchase-context.js";
import { armInvoiceSla, cancelInvoiceSla } from "./sla.js";
import { invoiceItemName } from "./parameters.js";
async function numberAvailable(
  tx: Tx,
  deps: InvoiceDeps,
  row: InvoiceRequest,
  invoiceNo: string,
  invoiceCode: string | null,
  red = false,
) {
  const p = await paramsAt(tx, ["invoice.no_rules"], deps.clock.now());
  if (
    !p["invoice.no_rules"][row.medium as "electronic" | "paper"].some((pattern) =>
      new RegExp(pattern).test(invoiceNo),
    ) ||
    (row.medium === "electronic" && !/^\d{20}$/.test(invoiceNo)) ||
    (invoiceNo.length === 8 && !invoiceCode) ||
    (invoiceCode !== null && !/^(?:\d{10}|\d{12})$/.test(invoiceCode))
  )
    throw new AppError("VALIDATION_FAILED");
  if (await tx.invoiceDoc.findFirst({ where: { invoiceNo, invoiceCode } }))
    throw new AppError("INVOICE_NO_TAKEN");
  if (red && (await tx.invoiceDoc.count({ where: { invoiceRequestId: row.id, docKind: "red" } })))
    throw new AppError("STATE_NOT_ALLOWED");
}
async function invoiceFile(
  tx: Tx,
  row: InvoiceRequest,
  staff: StaffContext,
  fileId: string,
  red: boolean,
) {
  await lockRows(tx, "file_object", [fileId]);
  const f = await tx.fileObject.findUnique({ where: { id: fileId } });
  if (
    !f ||
    f.status !== "stored" ||
    f.category !== "invoice" ||
    f.scopeType !== "entity" ||
    f.entityId !== row.entityId ||
    f.uploadActorType !== "staff" ||
    f.uploadActorId !== staff.staff.id ||
    f.moderationState === "block" ||
    !(red ? ["pdf", "ofd", "xml"] : ["pdf", "ofd"]).includes(f.ext)
  )
    throw new AppError("FILE_NOT_USABLE");
  return f;
}
export async function requestInvoice(
  tx: Tx,
  deps: InvoiceDeps,
  actor: PurchaseActor,
  input: InvoiceRequestCreateBody,
) {
  await assertInvoiceOwner(tx, deps, actor, true);
  await lockRows(tx, "billing_order", [input.paymentOrderId]);
  const order = await tx.billingOrder.findFirst({
    where: { id: input.paymentOrderId, entityId: actor.membership.entityId },
  });
  if (!order) throw new AppError("NOT_FOUND");
  const entity = await tx.entity.findUniqueOrThrow({ where: { id: order.entityId } });
  if (
    entity.verificationStatus !== "verified" ||
    !entity.name ||
    !entity.usccEnc ||
    !entity.usccMask
  )
    throw new AppError("INVOICE_TITLE_UNVERIFIED");
  const reasons = await invoiceReasons(tx, order, true);
  if (reasons.length) throw new AppError("INVOICE_NOT_ELIGIBLE", { details: { reasons } });
  const active = await tx.invoiceRequest.findFirst({
    where: { billingOrderId: order.id, status: { in: activeInvoiceStatuses } },
  });
  if (active)
    throw new AppError("INVOICE_REQUEST_EXISTS", {
      details: { invoiceRequestId: active.id, requestNo: active.requestNo },
    });
  const now = deps.clock.now(),
    p = await paramsAt(tx, ["invoice.apply_within_days", "sla.review.invoice_request"], now),
    days = p["invoice.apply_within_days"];
  if (days !== null && now.getTime() > order.paidAt!.getTime() + days * 86400000)
    throw new AppError("INVOICE_APPLY_EXPIRED", {
      details: { deadline: new Date(order.paidAt!.getTime() + days * 86400000).toISOString() },
    });
  const keyring = deps.keyring(),
    seal = (column: string, value: string | undefined) =>
      value === undefined ? null : encryptField(keyring, `invoice_request.${column}_enc`, value);
  let mailToEnc: string | null = null,
    mailToMask: string | null = null;
  if (input.mailTo) {
    const m = input.mailTo,
      user = await tx.merchantUser.findUniqueOrThrow({ where: { id: actor.ctx.actor.id! } }),
      profile = await tx.storeProfile.findUnique({ where: { storeId: actor.membership.storeId } });
    const phone =
      m.phoneSource === "input"
        ? m.phone
        : m.phoneSource === "login"
          ? user.phoneEnc
            ? openField(keyring, "merchant_user.phone_enc", user.phoneEnc)
            : undefined
          : profile?.contactPhoneEnc
            ? openField(keyring, "store_profile.contact_phone_enc", profile.contactPhoneEnc)
            : undefined;
    if (!phone)
      throw new AppError("VALIDATION_FAILED", {
        details: { fieldErrors: [{ path: "mailTo.phoneSource", message: "电话来源不可用" }] },
      });
    mailToEnc = seal(
      "mail_to",
      JSON.stringify({ recipientName: m.recipientName, phone, address: m.address }),
    );
    mailToMask = `${maskName(m.recipientName)} · ${maskPhone(phone)} · ${m.address.slice(0, 6)}****`;
  }
  const policy = p["sla.review.invoice_request"],
    due = policy
      ? await deps.sla.dueAt(tx, {
          policy: "review.invoice_request",
          ...policy,
          from: now,
          workHours: await workHoursAt(tx, now),
        })
      : null;
  const id = uuidv7(),
    requestNo = await deps.bizNo.next(tx, "KP"),
    row = await tx.invoiceRequest.create({
      data: {
        id,
        requestNo,
        billingOrderId: order.id,
        entityId: order.entityId,
        amountFen: order.paidAmountFen,
        invoiceType: input.invoiceType,
        medium: input.medium,
        title: entity.name,
        taxNoEnc: seal("tax_no", openField(keyring, "entity.uscc_enc", entity.usccEnc))!,
        taxNoMask: entity.usccMask,
        addrTelEnc: seal("addr_tel", input.addrTel),
        addrTelMask: input.addrTel ? "****" : null,
        bankAccountEnc: seal("bank_account", input.bankAccount),
        bankAccountMask: input.bankAccount ? maskBankAccount(input.bankAccount) : null,
        recvEmailEnc: seal("recv_email", input.recvEmail),
        recvEmailMask: input.recvEmail ? maskEmail(input.recvEmail) : null,
        mailToEnc,
        mailToMask,
        itemName: (await invoiceItemName(tx, order.type, now))!,
        status: "pending",
        appliedByUserId: actor.ctx.actor.id!,
        appliedAt: now,
        dueAt: due?.dueAt ?? null,
        ...(due ? { slaSnapshot: { ...due.snapshot } } : {}),
        createdAt: now,
        updatedAt: now,
      },
    });
  await deps.flow.transition(
    tx,
    { ...actor.ctx, storeId: null },
    {
      machine: "invoice_request",
      stateField: "status",
      id,
      event: "invoice.request",
      ref: "08:1110",
      created: true,
      audit: {
        stream: "activity",
        category: "invoice",
        action: "billing.invoice.request",
        summary: "申请开票",
        target: { type: "invoice_request", id },
        entityId: row.entityId,
        storeId: null,
      },
      emit: {
        type: "invoice.requested",
        payload: {
          v: 1,
          invoiceRequestId: id,
          billingOrderId: order.id,
          entityId: row.entityId,
          ...(row.dueAt ? { dueAt: row.dueAt.toISOString() } : {}),
        },
      },
    },
  );
  await armInvoiceSla(tx, deps, row);
  return invoiceCard(tx, row);
}
async function lockedInvoice(
  tx: Tx,
  deps: InvoiceDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  red = false,
) {
  await assertFinanceStaff(
    tx,
    deps,
    ctx,
    staff,
    red ? "finance.invoice.red" : "finance.invoice.issue",
  );
  const candidate = await invoiceInScope(tx, staff, id);
  await lockRows(tx, "billing_order", [candidate.billingOrderId]);
  await lockRows(tx, "invoice_request", [candidate.id]);
  return invoiceInScope(tx, staff, id);
}
export async function issueInvoice(
  tx: Tx,
  deps: InvoiceDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  input: InvoiceIssueBody | InvoiceIssueRedBody,
  red: boolean,
) {
  const row = await lockedInvoice(tx, deps, ctx, staff, id, red);
  if (row.status !== (red ? "red_pending" : "pending")) throw new AppError("STATE_NOT_ALLOWED");
  const order = await tx.billingOrder.findUniqueOrThrow({ where: { id: row.billingOrderId } }),
    blue = red
      ? await tx.invoiceDoc.findFirst({ where: { invoiceRequestId: id, docKind: "blue" } })
      : null;
  if (
    input.confirm.requestNo !== row.requestNo ||
    input.confirm.amountFen !== row.amountFen ||
    (red && (!blue || (input as InvoiceIssueRedBody).confirm.blueInvoiceNo !== blue.invoiceNo))
  )
    throw new AppError("CONFIRM_MISMATCH");
  if (!red) {
    const reasons = await invoiceReasons(tx, order);
    if (reasons.length) throw new AppError("INVOICE_ISSUE_BLOCKED", { details: { reasons } });
  }
  const code = input.invoiceCode ?? null;
  await numberAvailable(tx, deps, row, input.invoiceNo, code, red);
  const normal = input as InvoiceIssueBody;
  if (!red && row.medium === "paper" && (!normal.expressCompanyCode || !normal.trackingNo))
    throw new AppError("VALIDATION_FAILED");
  if (
    !red &&
    row.medium === "paper" &&
    !(await tx.dictItem.findFirst({
      where: { dictTypeKey: "express_company", code: normal.expressCompanyCode!, isEnabled: true },
    }))
  )
    throw new AppError("DICT_ITEM_DISABLED");
  if ((red || row.medium === "electronic") && !input.fileId)
    throw new AppError("VALIDATION_FAILED");
  const file = input.fileId ? await invoiceFile(tx, row, staff, input.fileId, red) : null,
    now = deps.clock.now(),
    docId = uuidv7(),
    needsEmail = !red && row.medium === "electronic" && row.recvEmailEnc !== null;
  await tx.invoiceDoc.create({
    data: {
      id: docId,
      entityId: row.entityId,
      invoiceRequestId: id,
      docKind: red ? "red" : "blue",
      invoiceNo: input.invoiceNo,
      invoiceCode: code,
      amountFen: red ? -blue!.amountFen : row.amountFen,
      fileId: file?.id ?? null,
      fileFormat: file?.ext ?? null,
      issuedAt: now,
      issuedByStaffId: staff.staff.id,
      ...(!red && row.medium === "paper"
        ? {
            expressCompany: normal.expressCompanyCode!,
            trackingNo: normal.trackingNo!,
            shippedAt: now,
          }
        : {}),
      emailState: needsEmail
        ? (await deps.invoiceMailEnabled(tx))
          ? "queued"
          : "skipped"
        : "none",
      ...(red
        ? { originalInvoiceDocId: blue!.id, redReason: (input as InvoiceIssueRedBody).redReason }
        : {}),
      createdAt: now,
      updatedAt: now,
    },
  });
  if (file)
    await deps.media.link(tx, {
      fileId: file.id,
      refType: "invoice_doc",
      refId: docId,
      role: "main",
      entityId: row.entityId,
      storeId: null,
    });
  await deps.flow.transition(
    tx,
    { ...ctx, entityId: row.entityId, storeId: null },
    {
      machine: "invoice_request",
      stateField: "status",
      id,
      event: red ? "invoice.issue_red" : "invoice.issue",
      ref: red ? "08:1116" : row.medium === "paper" ? "08:1112" : "08:1111",
      audit: {
        stream: "ops",
        category: "invoice",
        action: red ? "billing.invoice.issue_red" : "billing.invoice.issue",
        summary: red ? "回填红字发票" : "开具发票",
        target: { type: "invoice_request", id },
        entityId: row.entityId,
        storeId: null,
      },
      emit: red
        ? {
            type: "invoice.red_issued",
            aggregate: { type: "invoice_doc", id: docId },
            payload: { v: 1, invoiceDocId: docId, invoiceRequestId: id },
          }
        : {
            type: "invoice.issued",
            aggregate: { type: "invoice_doc", id: docId },
            payload: {
              v: 1,
              invoiceDocId: docId,
              invoiceRequestId: id,
              entityId: row.entityId,
              medium: InvoiceMediumSchema.parse(row.medium),
              needsEmail,
            },
          },
    },
  );
  await cancelInvoiceSla(tx, deps.timers, id);
  return invoiceAdminDetail(
    tx,
    await tx.invoiceRequest.findUniqueOrThrow({ where: { id } }),
    staff,
  );
}
export async function rejectInvoice(
  tx: Tx,
  deps: InvoiceDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  input: InvoiceRejectBody,
) {
  const row = await lockedInvoice(tx, deps, ctx, staff, id);
  if (row.status !== "pending") throw new AppError("STATE_NOT_ALLOWED");
  const reason = await tx.dictItem.findFirst({
    where: { dictTypeKey: "reject_reason", code: input.reasonCode, isEnabled: true },
  });
  if (!reason || (reason.ext as { scene?: string }).scene !== "invoice")
    throw new AppError("DICT_ITEM_DISABLED");
  await deps.flow.transition(
    tx,
    { ...ctx, entityId: row.entityId, storeId: null },
    {
      machine: "invoice_request",
      stateField: "status",
      id,
      event: "invoice.reject",
      ref: "08:1113",
      args: { reasonValidated: true },
      set: {
        reject_kind: "manual",
        reject_reason_code: input.reasonCode,
        reject_note: input.note,
        rejected_by_staff_id: staff.staff.id,
        rejected_at: deps.clock.now(),
      },
      audit: {
        stream: "ops",
        category: "invoice",
        action: "billing.invoice.reject",
        summary: "驳回开票申请",
        target: { type: "invoice_request", id },
        entityId: row.entityId,
        storeId: null,
      },
      emit: {
        type: "invoice.rejected",
        payload: { v: 1, invoiceRequestId: id, entityId: row.entityId, rejectKind: "manual" },
      },
    },
  );
  await cancelInvoiceSla(tx, deps.timers, id);
  return invoiceAdminDetail(
    tx,
    await tx.invoiceRequest.findUniqueOrThrow({ where: { id } }),
    staff,
  );
}
