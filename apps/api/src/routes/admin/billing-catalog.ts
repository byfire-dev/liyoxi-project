import {
  adminPlanList,
  adminPlanQuote,
  adminPlanUpdate,
  adminPlanShelve,
  adminPlanDelist,
  adminPlanCreate,
  adminPlanPlanRevisionCreate,
  adminPlanRevisionList,
  adminPlanRevisionWithdraw,
  adminPlanSummary,
  adminBillingParamList,
  adminBillingParamWithdraw,
  adminPricingChangeCreate,
  adminPricingChangeList,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";

const view = { module: "billing", need: "view" } as const;
export const adminBillingCatalogHandlers = [
  defineAdminHandler(adminPlanQuote, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.get("runtime").billingPlansAdmin.quote(staff.ctx, c.req.valid("json")));
  }),
  defineAdminHandler(adminBillingParamList, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.billingParameters.list(staff.ctx));
  }),
  defineAdminHandler(adminPricingChangeList, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.billingParameters.changes(staff.ctx, c.req.valid("query")));
  }),
  defineAdminHandler(adminPricingChangeCreate, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    const body = c.req.valid("json");
    if (body.tiers) staff.assertPermission("billing.price.edit");
    if (body.params) staff.assertPermission("billing.param.edit");
    return ok(
      c,
      await c.var.runtime.billingParameters.create(
        { identity: c.var.identity!, staff: staff.ctx },
        body,
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminBillingParamWithdraw, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billingParameters.withdraw(
        { identity: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").billingParamId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminPlanSummary, view, async (c, staff) => {
    c.header("Cache-Control", "private, max-age=60");
    return ok(c, await c.var.runtime.billingPlansAdmin.summary(staff.ctx));
  }),
  defineAdminHandler(adminPlanCreate, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billingPlansAdmin.create(
        { identity: c.var.identity!, staff: staff.ctx },
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminPlanPlanRevisionCreate, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billingPlansAdmin.createRevision(
        { identity: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").planId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminPlanRevisionList, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billingPlansAdmin.revisionList(staff.ctx, c.req.valid("query")),
    );
  }),
  defineAdminHandler(adminPlanRevisionWithdraw, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billingPlansAdmin.withdrawRevision(
        { identity: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").planRevisionId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
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
