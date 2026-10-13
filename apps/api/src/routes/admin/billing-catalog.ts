import { adminPlanList, adminPlanUpdate, adminPlanShelve, adminPlanDelist } from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";

const view = { module: "billing", need: "view" } as const;
export const adminBillingCatalogHandlers = [
  defineAdminHandler(adminPlanList, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.billingPlansAdmin.list(staff.ctx, c.req.valid("query")));
  }),
  defineAdminHandler(adminPlanUpdate, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billingPlansAdmin.update(
        { identity: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").planId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminPlanShelve, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billingPlansAdmin.shelve(
        { identity: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").planId,
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminPlanDelist, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billingPlansAdmin.delist(
        { identity: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").planId,
        { idem: idemOf(c) },
      ),
    );
  }),
];
