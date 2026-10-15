import {
  mPaymentOrderList,
  mPaymentOrderSummary,
  adminPaymentOrderList,
  adminPaymentOrderSummary,
  adminPaymentTransactionList,
  adminPaymentTransactionSummary,
} from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import type { PurchaseActor } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { ok } from "../http/errors.js";
import { defineHandler } from "../routing/define.js";
import { defineAdminHandler } from "../routing/admin.js";

function actor(c: Context<ApiEnv>): PurchaseActor {
  if (!c.var.identity || !c.var.membership) throw new AppError("AUTH_REQUIRED");
  return { ctx: c.var.identity, membership: c.var.membership };
}
// /summary 字面路由须在已有 /{paymentOrderId} 之前注册。
export const billingChannelReadHandlers = [
  defineHandler(mPaymentOrderList, async (c) =>
    ok(c, await c.var.runtime.billing.listMerchantOrders(actor(c), c.req.valid("query"))),
  ),
  defineHandler(mPaymentOrderSummary, async (c) =>
    ok(c, await c.var.runtime.billing.merchantOrderSummary(actor(c), c.req.valid("query"))),
  ),
  defineAdminHandler(adminPaymentOrderList, { module: "order", need: "view" }, async (c, s) =>
    ok(c, await c.var.runtime.billing.listAdminOrders(s.ctx, c.req.valid("query"))),
  ),
  defineAdminHandler(adminPaymentOrderSummary, { module: "order", need: "view" }, async (c, s) =>
    ok(c, await c.var.runtime.billing.adminOrderSummary(s.ctx, c.req.valid("query"))),
  ),
  defineAdminHandler(
    adminPaymentTransactionList,
    { module: "finance", need: "view" },
    async (c, s) =>
      ok(c, await c.var.runtime.billing.listPaymentTransactions(s.ctx, c.req.valid("query"))),
  ),
  defineAdminHandler(
    adminPaymentTransactionSummary,
    { module: "finance", need: "view" },
    async (c, s) =>
      ok(c, await c.var.runtime.billing.paymentTransactionSummary(s.ctx, c.req.valid("query"))),
  ),
];
