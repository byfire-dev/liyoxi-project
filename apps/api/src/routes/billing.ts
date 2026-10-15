import {
  mPaymentOrderWechatPrepay,
  mWalletGet,
  mPurchasePolicyGet,
  mPlanList,
  mPlanQuote,
  mPaymentOrderCreate,
  mPaymentOrderGet,
  mPaymentOrderTransferProofCreate,
} from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import type { PurchaseActor } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { ok } from "../http/errors.js";
import { idemOf } from "../http/idempotency.js";
import { defineHandler } from "../routing/define.js";
function actor(c: Context<ApiEnv>): PurchaseActor {
  if (!c.var.identity || !c.var.membership) throw new AppError("AUTH_REQUIRED");
  return { ctx: c.var.identity, membership: c.var.membership };
}
function client(c: Context<ApiEnv>) {
  return {
    platform: c.req.header("X-Client-Platform") ?? "unknown",
    ...(c.req.header("X-Client-Version") ? { appVersion: c.req.header("X-Client-Version")! } : {}),
  };
}
export const billingHandlers = [
  defineHandler(mPaymentOrderWechatPrepay, async (c) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.wechatPrepay(
        actor(c),
        client(c),
        c.req.valid("param").paymentOrderId,
        { idem: idemOf(c), session: c.var.merchantSession },
      ),
    );
  }),
  defineHandler(mWalletGet, async (c) =>
    ok(c, await c.var.runtime.billing.wallet(actor(c), client(c))),
  ),
  defineHandler(mPurchasePolicyGet, async (c) =>
    ok(c, await c.var.runtime.billing.getPurchasePolicy(actor(c), client(c))),
  ),
  defineHandler(mPlanList, async (c) =>
    ok(c, await c.var.runtime.billing.listPlans(actor(c), client(c))),
  ),
  defineHandler(mPlanQuote, async (c) =>
    ok(c, await c.var.runtime.billing.quotePlanPurchase(actor(c), client(c), c.req.valid("json"))),
  ),
  defineHandler(mPaymentOrderCreate, async (c) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.createOrder(actor(c), client(c), c.req.valid("json"), {
        idem: idemOf(c),
      }),
    );
  }),
  defineHandler(mPaymentOrderGet, async (c) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.getOrder(
        actor(c),
        client(c),
        c.req.valid("param").paymentOrderId,
      ),
    );
  }),
  defineHandler(mPaymentOrderTransferProofCreate, async (c) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.billing.submitProof(
        actor(c),
        client(c),
        c.req.valid("param").paymentOrderId,
        c.req.valid("json").fileId,
        { idem: idemOf(c) },
      ),
    );
  }),
];
