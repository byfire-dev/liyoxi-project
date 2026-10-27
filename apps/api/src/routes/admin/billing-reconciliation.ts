import { adminReconciliationList, adminReconciliationRerun } from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
export const adminBillingReconciliationHandlers = [
  defineAdminHandler(adminReconciliationList, { module: "finance", need: "view" }, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.billing.reconciliation.list(s.ctx, c.req.valid("query")));
  }),
  defineAdminHandler(adminReconciliationRerun, null, async (c, s) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.reconciliation.rerun(
        c.var.identity!,
        s.ctx,
        c.req.valid("param").reconciliationId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
];
