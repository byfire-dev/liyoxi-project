import {
  adminPointPackCreate,
  adminPointPackList,
  adminPointPackSummary,
  adminPointPackUpdate,
  adminPointPackShelve,
  adminPointPackDelist,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
const view = { module: "billing", need: "view" } as const;
export const adminBillingPointPackHandlers = [
  defineAdminHandler(adminPointPackList, view, async (c, staff) =>
    ok(c, await c.var.runtime.billing.pointPacks.listAdmin(staff.ctx, c.req.valid("query"))),
  ),
  defineAdminHandler(adminPointPackSummary, view, async (c, staff) =>
    ok(c, await c.var.runtime.billing.pointPacks.summary(staff.ctx)),
  ),
  defineAdminHandler(adminPointPackCreate, view, async (c, staff) =>
    ok(
      c,
      await c.var.runtime.billing.pointPacks.create(
        { identity: c.var.identity!, staff: staff.ctx },
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
  defineAdminHandler(adminPointPackUpdate, view, async (c, staff) =>
    ok(
      c,
      await c.var.runtime.billing.pointPacks.update(
        { identity: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").pointPackId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    ),
  ),
  defineAdminHandler(adminPointPackShelve, view, async (c, staff) =>
    ok(
      c,
      await c.var.runtime.billing.pointPacks.shelve(
        { identity: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").pointPackId,
        { idem: idemOf(c) },
      ),
    ),
  ),
  defineAdminHandler(adminPointPackDelist, view, async (c, staff) =>
    ok(
      c,
      await c.var.runtime.billing.pointPacks.delist(
        { identity: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").pointPackId,
        { idem: idemOf(c) },
      ),
    ),
  ),
];
