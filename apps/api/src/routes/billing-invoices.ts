import {
  mInvoiceRequestCreate,
  mInvoiceRequestList,
  mInvoiceRequestSummary,
  mInvoiceRequestDownloadUrls,
} from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import type { PurchaseActor } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { ok } from "../http/errors.js";
import { idemOf } from "../http/idempotency.js";
import { defineHandler } from "../routing/define.js";
function actor(c: Context<ApiEnv>): PurchaseActor {
  if (!c.var.identity || !c.var.membership) throw new AppError("AUTH_REQUIRED");
  return { ctx: c.var.identity, membership: c.var.membership };
}
export const billingInvoiceHandlers = [
  defineHandler(mInvoiceRequestCreate, async (c) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.invoices.create(actor(c), c.req.valid("json"), {
        idem: idemOf(c),
      }),
    );
  }),
  defineHandler(mInvoiceRequestList, async (c) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.billing.invoices.list(actor(c), c.req.valid("query")));
  }),
  defineHandler(mInvoiceRequestSummary, async (c) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.billing.invoices.summary(actor(c), c.req.valid("query")));
  }),
  defineHandler(mInvoiceRequestDownloadUrls, async (c) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.invoices.download(
        actor(c),
        c.req.valid("param").invoiceRequestId,
        c.req.valid("json").docKind,
      ),
    );
  }),
];
