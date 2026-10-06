import { mOrderQuote, mOrderCreate } from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import type { OrderActor } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { ok } from "../http/errors.js";
import { idemOf } from "../http/idempotency.js";
import { defineHandler } from "../routing/define.js";
function actor(c: Context<ApiEnv>): OrderActor {
  if (!c.var.identity || !c.var.membership) throw new AppError("AUTH_REQUIRED");
  return { ctx: c.var.identity, membership: c.var.membership };
}
export const orderHandlers = [
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
