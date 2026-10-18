import {
  adminInvoiceRequestList,
  adminInvoiceRequestSummary,
  adminInvoiceRequestGet,
  adminInvoiceRequestIssue,
  adminInvoiceRequestIssueRed,
  adminInvoiceRequestReject,
  adminInvoiceRequestResend,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
const view = { module: "finance", need: "view" } as const;
export const adminBillingInvoiceHandlers = [
  defineAdminHandler(adminInvoiceRequestList, view, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.billing.invoices.adminList(s.ctx, c.req.valid("query")));
  }),
  defineAdminHandler(adminInvoiceRequestSummary, view, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.billing.invoices.adminSummary(s.ctx, c.req.valid("query")));
  }),
  defineAdminHandler(adminInvoiceRequestGet, view, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.invoices.get(s.ctx, c.req.valid("param").invoiceRequestId),
    );
  }),
  defineAdminHandler(adminInvoiceRequestIssue, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.invoices.issue(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").invoiceRequestId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminInvoiceRequestIssueRed, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.invoices.issueRed(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").invoiceRequestId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminInvoiceRequestReject, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.invoices.reject(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").invoiceRequestId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminInvoiceRequestResend, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.invoices.resend(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").invoiceRequestId,
        { idem: idemOf(c) },
      ),
    );
  }),
];
