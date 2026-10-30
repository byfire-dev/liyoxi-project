import {
  adminOrderQuote,
  adminOrderActivityList,
  adminSampleMarkSent,
  OrderQuoteResultSchema,
  OrderActivityPageSchema,
  AdminSampleViewSchema,
} from "@liyoxi/contract";
import type { Context } from "hono";
import type { ApiEnv } from "../../context.js";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
import { deliveryOf } from "../delivery.js";
const privateOk = <T>(c: Context<ApiEnv>, data: T) => {
  c.header("Cache-Control", "no-store");
  return ok(c, data);
};
export const adminSampleOrderM5Handlers = [
  defineAdminHandler(adminOrderQuote, { module: "billing", need: "view" }, async (c) =>
    privateOk(
      c,
      OrderQuoteResultSchema.parse(await c.var.runtime.order.adminQuote(c.req.valid("json"))),
    ),
  ),
  defineAdminHandler(adminOrderActivityList, { module: "order", need: "view" }, async (c, staff) =>
    privateOk(
      c,
      OrderActivityPageSchema.parse(
        await c.var.runtime.order.activityList(
          staff.ctx.scope,
          c.req.valid("param").orderId,
          c.req.valid("query"),
        ),
      ),
    ),
  ),
  defineAdminHandler(adminSampleMarkSent, { module: "delivery", need: "edit" }, async (c, staff) =>
    privateOk(
      c,
      AdminSampleViewSchema.parse(
        await deliveryOf(c.var.runtime).sampleMarkSent(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").sampleId,
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
];
