import { z } from "zod";
import { IdSchema, InstantSchema, InvoiceDownloadSchema } from "@liyoxi/contract";
import type {
  InvoiceRequestCreateBody,
  InvoiceRequestListQuery,
  InvoiceRequestFilter,
  AdminInvoiceListQuery,
  AdminInvoiceFilter,
  InvoiceIssueBody,
  InvoiceIssueRedBody,
  InvoiceRejectBody,
} from "@liyoxi/contract";
import { AppError, isUniqueViolation, lockRows } from "../../kernel/index.js";
import type { IdentityContext, IdempotencyContext, Tx } from "../../kernel/index.js";
import { record } from "../../audit/index.js";
import { formatLocalDate, startOfDay, toLocalParts } from "@liyoxi/shared/time";
import type { StaffContext } from "../../authz/index.js";
import { assertFinanceStaff } from "../finance-config/service.js";
import { assertFinanceView } from "../finance-config/read.js";
import type { PurchaseActor } from "../payment/purchase-context.js";
import { dictRef } from "../payment/purchase-read.js";
import { assertInvoiceOwner } from "./context.js";
import type { InvoiceDeps } from "./context.js";
import {
  invoiceInScope,
  merchantInvoiceWhere,
  adminInvoiceWhere,
  invoiceCard,
  invoiceAdminRow,
  invoiceAdminDetail,
} from "./read.js";
import { requestInvoice, issueInvoice, rejectInvoice } from "./write.js";
const Cursor = z.strictObject({ id: IdSchema, at: InstantSchema, scope: z.string() });
async function invoiceNumberWrite<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    // The transaction must have rolled back before mapping the concurrent loser.
    if (isUniqueViolation(error, ["uq_invoice_doc_code_no"]))
      throw new AppError("INVOICE_NO_TAKEN");
    throw error;
  }
}
function cursor(raw: string | undefined, scope: string) {
  if (!raw) return null;
  try {
    const c = Cursor.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (c.scope !== scope) throw new Error();
    return c;
  } catch {
    throw new AppError("VALIDATION_FAILED");
  }
}
export function createInvoices(deps: InvoiceDeps) {
  const precheck = (ctx: IdentityContext, staff: StaffContext, id: string, red = false) =>
    deps.tx.run(async (tx) => {
      await assertFinanceStaff(
        tx,
        deps,
        ctx,
        staff,
        red ? "finance.invoice.red" : "finance.invoice.issue",
      );
      await invoiceInScope(tx, staff, id);
    });
  return {
    create: async (
      actor: PurchaseActor,
      input: InvoiceRequestCreateBody,
      options: { idem?: IdempotencyContext } = {},
    ) => {
      await deps.tx.run((tx) => assertInvoiceOwner(tx, deps, actor));
      return deps.tx.run((tx) => requestInvoice(tx, deps, actor, input), options);
    },
    list: (actor: PurchaseActor, query: InvoiceRequestListQuery) =>
      deps.tx.run(async (tx) => {
        await assertInvoiceOwner(tx, deps, actor);
        const scope = JSON.stringify([
            actor.membership.entityId,
            query.status ?? null,
            query.paymentOrderId ?? null,
            query.no ?? null,
          ]),
          c = cursor(query.cursor, scope),
          where = merchantInvoiceWhere(actor.membership.entityId, query);
        const rows = await tx.invoiceRequest.findMany({
            where: {
              ...where,
              ...(c
                ? {
                    OR: [
                      { appliedAt: { lt: new Date(c.at) } },
                      { appliedAt: new Date(c.at), id: { lt: c.id } },
                    ],
                  }
                : {}),
            },
            orderBy: [{ appliedAt: "desc" }, { id: "desc" }],
            take: query.limit + 1,
          }),
          more = rows.length > query.limit,
          visible = rows.slice(0, query.limit),
          last = visible.at(-1);
        return {
          items: await Promise.all(visible.map((r) => invoiceCard(tx, r))),
          hasMore: more,
          nextCursor:
            more && last
              ? Buffer.from(
                  JSON.stringify({ id: last.id, at: last.appliedAt.toISOString(), scope }),
                ).toString("base64url")
              : null,
        };
      }),
    summary: (actor: PurchaseActor, query: InvoiceRequestFilter) =>
      deps.tx.run(async (tx) => {
        await assertInvoiceOwner(tx, deps, actor);
        const rows = await tx.invoiceRequest.findMany({
            where: merchantInvoiceWhere(actor.membership.entityId, query),
            select: { status: true },
          }),
          entity = await tx.entity.findUniqueOrThrow({ where: { id: actor.membership.entityId } }),
          profile = await tx.storeProfile.findUnique({
            where: { storeId: actor.membership.storeId },
          }),
          user = await tx.merchantUser.findUniqueOrThrow({ where: { id: actor.ctx.actor.id! } }),
          byStatus = { pending: 0, issued: 0, rejected: 0, red_pending: 0, red_issued: 0 };
        for (const r of rows)
          if (Object.hasOwn(byStatus, r.status)) byStatus[r.status as keyof typeof byStatus]++;
        const address = profile
          ? [
              ...(
                await Promise.all(
                  [profile.provinceCode, profile.cityCode, profile.districtCode]
                    .filter((v): v is string => v !== null)
                    .map((code) => dictRef(tx, "region", code)),
                )
              ).map((d) => d?.name ?? ""),
              profile.addressDetail ?? "",
            ].join("")
          : null;
        return {
          total: rows.length,
          byStatus,
          context: {
            invoiceTitle: {
              entityName: entity.verificationStatus === "verified" ? entity.name : null,
              taxNoMask: entity.verificationStatus === "verified" ? entity.usccMask : null,
              isVerified: entity.verificationStatus === "verified",
            },
            applyDefaults: {
              recipientName: profile?.contactName ?? null,
              contactPhoneMask: profile?.contactPhoneMask ?? null,
              loginPhoneMask: user.phoneMask,
              address,
              addrTel: address
                ? `${address}${profile?.storeTel ? ` ${profile.storeTel}` : ""}`
                : null,
            },
          },
        };
      }),
    download: async (actor: PurchaseActor, id: string, docKind: "blue" | "red") => {
      const read = async (tx: Tx) => {
        await assertInvoiceOwner(tx, deps, actor);
        const row = await tx.invoiceRequest.findFirst({
          where: { id, entityId: actor.membership.entityId },
        });
        if (!row) throw new AppError("NOT_FOUND");
        const doc = await tx.invoiceDoc.findFirst({ where: { invoiceRequestId: id, docKind } });
        if (!doc?.fileId || !doc.fileFormat) throw new AppError("INVOICE_FILE_UNAVAILABLE");
        const live = await tx.fileRef.findFirst({
          where: {
            fileId: doc.fileId,
            refType: "invoice_doc",
            refId: doc.id,
            role: "main",
            state: "live",
          },
        });
        if (!live) throw new AppError("INVOICE_FILE_UNAVAILABLE");
        return doc;
      };
      const doc = await deps.tx.run(read),
        signed = await deps.invoiceMedia.signRead({
          fileId: doc.fileId!,
          audience: "merchant",
          disposition: "attachment",
        });
      await deps.tx.run(async (tx) => {
        const current = await read(tx);
        if (current.fileId !== doc.fileId) throw new AppError("INVOICE_FILE_UNAVAILABLE");
        await record(
          tx,
          actor.ctx.actor,
          {
            requestId: actor.ctx.requestId,
            ip: actor.ctx.ip,
            userAgent: actor.ctx.userAgent,
            authMethod: null,
            sessionId: null,
          },
          {
            stream: "access",
            category: "file_access",
            action: "billing.invoice.download",
            summary: "签发发票下载地址",
            target: { type: "invoice_doc", id: doc.id },
            entityId: doc.entityId,
            storeId: null,
            meta: { docKind, urlTtlSec: 300 },
          },
        );
      });
      return InvoiceDownloadSchema.parse({
        ...signed,
        fileFormat: doc.fileFormat,
        fileName: `${doc.invoiceNo}.${doc.fileFormat}`,
      });
    },
    adminList: (staff: StaffContext, query: AdminInvoiceListQuery) =>
      deps.tx.run(async (tx) => {
        assertFinanceView(staff);
        const where = {
          ...adminInvoiceWhere(staff, query),
          status:
            query.tab === "processed" ? { in: ["issued", "rejected", "red_issued"] } : query.tab,
        };
        const rows = await tx.invoiceRequest.findMany({
          where,
          orderBy:
            query.tab === "pending"
              ? [{ appliedAt: "asc" }, { id: "asc" }]
              : [{ updatedAt: "desc" }, { id: "desc" }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        });
        return {
          items: await Promise.all(rows.map((r) => invoiceAdminRow(tx, r))),
          page: query.page,
          pageSize: query.pageSize,
          total: await tx.invoiceRequest.count({ where }),
        };
      }),
    adminSummary: (staff: StaffContext, query: AdminInvoiceFilter) =>
      deps.tx.run(async (tx) => {
        assertFinanceView(staff);
        const where = adminInvoiceWhere(staff, query),
          rows = await tx.invoiceRequest.findMany({
            where,
            select: { status: true, amountFen: true },
          }),
          { year, month } = toLocalParts(deps.clock.now()),
          start = startOfDay(formatLocalDate(year, month, 1)),
          next = startOfDay(
            formatLocalDate(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1),
          );
        const docs = await tx.invoiceDoc.findMany({
          where: { docKind: "blue", issuedAt: { gte: start, lt: next }, invoiceRequest: where },
          select: { amountFen: true },
        });
        return {
          pending: rows.filter((r) => r.status === "pending").length,
          red_pending: rows.filter((r) => r.status === "red_pending").length,
          processed: rows.filter((r) => ["issued", "rejected", "red_issued"].includes(r.status))
            .length,
          pendingAmountFen: rows
            .reduce((n, r) => n + (r.status === "pending" ? BigInt(r.amountFen) : 0n), 0n)
            .toString(),
          issuedThisMonth: {
            amountFen: docs.reduce((n, r) => n + BigInt(r.amountFen), 0n).toString(),
            count: docs.length,
          },
        };
      }),
    get: (staff: StaffContext, id: string) =>
      deps.tx.run(async (tx) => {
        assertFinanceView(staff);
        return invoiceAdminDetail(tx, await invoiceInScope(tx, staff, id), staff);
      }),
    issue: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: InvoiceIssueBody,
      options: { idem?: IdempotencyContext } = {},
    ) => {
      await precheck(ctx, staff, id);
      return invoiceNumberWrite(() =>
        deps.tx.run((tx) => issueInvoice(tx, deps, ctx, staff, id, input, false), options),
      );
    },
    issueRed: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: InvoiceIssueRedBody,
      options: { idem?: IdempotencyContext } = {},
    ) => {
      await precheck(ctx, staff, id, true);
      return invoiceNumberWrite(() =>
        deps.tx.run((tx) => issueInvoice(tx, deps, ctx, staff, id, input, true), options),
      );
    },
    reject: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: InvoiceRejectBody,
      options: { idem?: IdempotencyContext } = {},
    ) => {
      await precheck(ctx, staff, id);
      return deps.tx.run((tx) => rejectInvoice(tx, deps, ctx, staff, id, input), options);
    },
    resend: async (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      options: { idem?: IdempotencyContext } = {},
    ) => {
      await precheck(ctx, staff, id);
      return deps.tx.run(async (tx) => {
        await assertFinanceStaff(tx, deps, ctx, staff, "finance.invoice.issue");
        const c = await invoiceInScope(tx, staff, id);
        await lockRows(tx, "billing_order", [c.billingOrderId]);
        await lockRows(tx, "invoice_request", [c.id]);
        const row = await invoiceInScope(tx, staff, id),
          doc = await tx.invoiceDoc.findFirst({ where: { invoiceRequestId: id, docKind: "blue" } });
        if (!doc || row.medium !== "electronic" || !row.recvEmailEnc || doc.emailState !== "failed")
          throw new AppError("STATE_NOT_ALLOWED");
        await deps.resendMail(tx, doc.id);
        await tx.invoiceDoc.update({
          where: { id: doc.id },
          data: { emailState: "queued", emailSentAt: null, updatedAt: deps.clock.now() },
        });
        await record(
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
            stream: "ops",
            category: "invoice",
            action: "billing.invoice.resend",
            summary: "重发电子发票邮件",
            target: { type: "invoice_request", id },
            entityId: row.entityId,
            storeId: null,
          },
        );
        return invoiceAdminDetail(tx, row, staff);
      }, options);
    },
  };
}
