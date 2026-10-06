import {
  mOrderQuote,
  mOrderCreate,
  mCartItemList,
  mCartItemCreate,
  mCartItemDelete,
  mCartItemAcceptPrice,
  mOrderList,
  mOrderGet,
  mOrderItemList,
  mOrderItemSummary,
  mOrderItemGet,
  adminOrderList,
  adminOrderSummary,
  adminOrderGet,
} from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import type { OrderActor } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { ok } from "../http/errors.js";
import { idemOf } from "../http/idempotency.js";
import { defineHandler } from "../routing/define.js";
import { defineAdminHandler } from "../routing/admin.js";
function actor(c: Context<ApiEnv>): OrderActor {
  if (!c.var.identity || !c.var.membership) throw new AppError("AUTH_REQUIRED");
  return { ctx: c.var.identity, membership: c.var.membership };
}
export const orderHandlers = [
  defineHandler(mCartItemList, async (c) => ok(c, await c.var.runtime.order.cartList(actor(c)))),
  defineHandler(mCartItemCreate, async (c) =>
    ok(c, await c.var.runtime.order.cartCreate(actor(c), c.req.valid("json").dramaId)),
  ),
  defineHandler(mCartItemDelete, async (c) =>
    ok(
      c,
      await c.var.runtime.order.cartDelete(actor(c), c.req.valid("param").cartItemId, {
        idem: idemOf(c),
      }),
    ),
  ),
  defineHandler(mCartItemAcceptPrice, async (c) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.order.cartAcceptPrice(
        actor(c),
        c.req.valid("param").cartItemId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineHandler(mOrderList, async (c) =>
    ok(c, await c.var.runtime.order.list(actor(c), c.req.valid("query"))),
  ),
  defineHandler(mOrderGet, async (c) =>
    ok(c, await c.var.runtime.order.get(actor(c), c.req.valid("param").orderId)),
  ),
  defineHandler(mOrderItemList, async (c) =>
    ok(c, await c.var.runtime.order.itemList(actor(c), c.req.valid("query"))),
  ),
  defineHandler(mOrderItemSummary, async (c) =>
    ok(c, await c.var.runtime.order.itemSummary(actor(c), c.req.valid("query").orderId)),
  ),
  defineHandler(mOrderItemGet, async (c) =>
    ok(c, await c.var.runtime.order.itemGet(actor(c), c.req.valid("param").orderItemId)),
  ),
  defineAdminHandler(adminOrderList, { module: "order", need: "view" }, async (c, staff) =>
    ok(c, await c.var.runtime.order.adminList(staff.scope, c.req.valid("query"))),
  ),
  defineAdminHandler(adminOrderSummary, { module: "order", need: "view" }, async (c, staff) =>
    ok(c, await c.var.runtime.order.adminSummary(staff.scope, c.req.valid("query"))),
  ),
  defineAdminHandler(adminOrderGet, { module: "order", need: "view" }, async (c, staff) =>
    ok(c, await c.var.runtime.order.adminGet(staff.scope, c.req.valid("param").orderId)),
  ),
  defineHandler(mOrderQuote, async (c) =>
    ok(c, await c.var.runtime.order.quote(actor(c), c.req.valid("json"))),
  ),
  defineHandler(mOrderCreate, async (c) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.order.create(actor(c), c.req.valid("json"), { idem: idemOf(c) }),
    );
  }),
];
