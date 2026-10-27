import {
  adminPaymentOrderRefundQuote,
  adminPaymentOrderRefundRequestCreate,
  adminRefundRequestList,
  adminRefundRequestSummary,
  adminRefundRequestGet,
  adminRefundRequestApprove,
  adminRefundRequestConfirmNotAccepted,
  adminRefundRequestExecute,
  adminRefundRequestRecordOffline,
  adminRefundRequestReject,
  adminRefundRequestRetry,
  adminRefundRequestVoid,
  adminRefundRequestWithdraw,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
export const adminBillingRefundHandlers = [
  defineAdminHandler(adminPaymentOrderRefundQuote, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.refunds.quote(
        s.ctx,
        c.req.valid("param").paymentOrderId,
        c.req.valid("json").ruleCode,
      ),
    ),
  ),
  defineAdminHandler(adminPaymentOrderRefundRequestCreate, null, async (c, s) =>
    ok(
      c,
      await c.var.runtime.billing.refunds.create(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").paymentOrderId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
  defineAdminHandler(adminRefundRequestList, { module: "finance", need: "view" }, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.billing.refunds.list(s.ctx, c.req.valid("query")));
  }),
  defineAdminHandler(
    adminRefundRequestSummary,
    { module: "finance", need: "view" },
    async (c, s) => {
      c.header("Cache-Control", "no-store");
      return ok(c, await c.var.runtime.billing.refunds.summary(s.ctx, c.req.valid("query")));
    },
  ),
  defineAdminHandler(adminRefundRequestGet, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.refunds.get(s.ctx, c.req.valid("param").refundRequestId),
    );
  }),
  defineAdminHandler(adminRefundRequestApprove, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.refunds.approve(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").refundRequestId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminRefundRequestConfirmNotAccepted, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.refunds.confirmNotAccepted(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").refundRequestId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminRefundRequestExecute, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.refunds.execute(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").refundRequestId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminRefundRequestRecordOffline, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.refunds.recordOffline(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").refundRequestId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminRefundRequestReject, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.refunds.reject(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").refundRequestId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminRefundRequestRetry, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.refunds.retry(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").refundRequestId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminRefundRequestVoid, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.refunds.void(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").refundRequestId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminRefundRequestWithdraw, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.refunds.withdraw(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").refundRequestId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
];
