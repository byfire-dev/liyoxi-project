import {
  adminFinanceConfigRevisionList,
  adminFinanceConfigRevisionCreate,
  adminFinanceConfigRevisionApprove,
  adminFinanceConfigRevisionReject,
  adminFinanceConfigRevisionWithdraw,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
export const adminBillingFinanceConfigHandlers = [
  defineAdminHandler(
    adminFinanceConfigRevisionList,
    { module: "finance", need: "view" },
    async (c, s) => {
      c.header("Cache-Control", "no-store");
      return ok(c, await c.var.runtime.billing.financeConfig.list(s.ctx, c.req.valid("query")));
    },
  ),
  defineAdminHandler(adminFinanceConfigRevisionCreate, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.financeConfig.create(
        c.var.identity!,
        s.ctx,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminFinanceConfigRevisionApprove, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.financeConfig.approve(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").financeConfigRevisionId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminFinanceConfigRevisionReject, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.financeConfig.reject(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").financeConfigRevisionId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminFinanceConfigRevisionWithdraw, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.financeConfig.withdraw(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").financeConfigRevisionId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
];
