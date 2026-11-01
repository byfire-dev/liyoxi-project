import {
  adminAdCancelQuote,
  adminAdCancelRequestCreate,
  CancelQuoteSchema,
  CancelRequestDetailSchema,
} from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";

export const adminAdCancelHandlers = [
  defineAdminHandler(adminAdCancelQuote, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      CancelQuoteSchema.parse(
        await c.var.runtime.adCancelRequests.quote(
          { ctx: c.var.identity!, staff: staff.ctx },
          c.req.valid("param").adId,
          c.req.valid("json"),
        ),
      ),
    );
  }),
  defineAdminHandler(adminAdCancelRequestCreate, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      CancelRequestDetailSchema.parse(
        await c.var.runtime.adCancelRequests.create(
          { ctx: c.var.identity!, staff: staff.ctx },
          c.req.valid("param").adId,
          c.req.valid("json"),
          idemOf(c),
        ),
      ),
    );
  }),
];
