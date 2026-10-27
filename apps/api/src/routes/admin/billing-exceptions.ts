import {
  adminPaymentExceptionCreate,
  adminPaymentExceptionGet,
  adminPaymentExceptionList,
  adminPaymentExceptionResolve,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";

export const adminBillingExceptionHandlers = [
  defineAdminHandler(
    adminPaymentExceptionList,
    { module: "finance", need: "view" },
    async (c, s) => {
      c.header("Cache-Control", "no-store");
      return ok(c, await c.var.runtime.billing.paymentExceptions.list(s.ctx, c.req.valid("query")));
    },
  ),
  defineAdminHandler(
    adminPaymentExceptionGet,
    { module: "finance", need: "view" },
    async (c, s) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await c.var.runtime.billing.paymentExceptions.get(
          s.ctx,
          c.req.valid("param").paymentExceptionId,
        ),
      );
    },
  ),
  defineAdminHandler(adminPaymentExceptionCreate, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.paymentExceptions.create(
        c.var.identity!,
        s.ctx,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminPaymentExceptionResolve, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.paymentExceptions.resolve(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").paymentExceptionId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
];
