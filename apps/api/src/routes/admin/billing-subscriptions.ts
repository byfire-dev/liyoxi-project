import {
  adminSubscriptionTermList,
  adminSubscriptionTermSummary,
  adminSubscriptionTermGet,
  adminSubscriptionTermRemind,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
const view = { module: "order", need: "view" } as const;
export const adminBillingSubscriptionHandlers = [
  defineAdminHandler(adminSubscriptionTermList, view, async (c, staff) =>
    ok(c, await c.var.runtime.billing.subscriptions.list(staff.ctx, c.req.valid("query"))),
  ),
  defineAdminHandler(adminSubscriptionTermSummary, view, async (c, staff) =>
    ok(c, await c.var.runtime.billing.subscriptions.summary(staff.ctx, c.req.valid("query"))),
  ),
  defineAdminHandler(adminSubscriptionTermGet, view, async (c, staff) =>
    ok(
      c,
      await c.var.runtime.billing.subscriptions.get(
        staff.ctx,
        c.req.valid("param").subscriptionTermId,
      ),
    ),
  ),
  defineAdminHandler(adminSubscriptionTermRemind, view, async (c, staff) =>
    ok(
      c,
      await c.var.runtime.billing.subscriptions.remind(
        { identity: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").subscriptionTermId,
        { idem: idemOf(c) },
      ),
    ),
  ),
];
