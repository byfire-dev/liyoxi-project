import {
  adminDramaDramaPriceRevisionCreate,
  adminDramaPriceList,
  adminDramaPriceSummary,
  adminDramaPriceRevisionList,
  adminDramaPriceRevisionWithdraw,
  adminPriceTierRevisionList,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
import { contentActor } from "./dramas.js";
const view = { module: "billing", need: "view" } as const;
export const adminDramaPricingHandlers = [
  defineAdminHandler(adminDramaPriceList, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.contentAdmin.listPrices(staff.ctx, c.req.valid("query")));
  }),
  defineAdminHandler(adminDramaPriceSummary, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.contentAdmin.priceSummary(staff.ctx));
  }),
  defineAdminHandler(adminDramaPriceRevisionList, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.contentAdmin.priceRevisions(staff.ctx, c.req.valid("query")));
  }),
  defineAdminHandler(adminPriceTierRevisionList, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.contentAdmin.priceTiers(staff.ctx));
  }),
  defineAdminHandler(adminDramaDramaPriceRevisionCreate, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    const result = await c.var.runtime.contentAdmin.createPrice(
      contentActor(c, staff),
      c.req.valid("param").dramaId,
      c.req.valid("json"),
      { idem: idemOf(c) },
    );
    if (!idemOf(c)?.replayed) await c.var.runtime.config.cache.bump("site");
    return ok(c, result);
  }),
  defineAdminHandler(adminDramaPriceRevisionWithdraw, view, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.contentAdmin.withdrawPrice(
        contentActor(c, staff),
        c.req.valid("param").dramaPriceRevisionId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
];
