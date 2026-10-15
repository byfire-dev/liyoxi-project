import { mPointPackList } from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import { ok } from "../http/errors.js";
import { defineHandler } from "../routing/define.js";
export const billingPointPackHandlers = [
  defineHandler(mPointPackList, async (c) => {
    if (!c.var.identity || !c.var.membership) throw new AppError("AUTH_REQUIRED");
    return ok(
      c,
      await c.var.runtime.billing.pointPacks.listMerchant(
        { ctx: c.var.identity, membership: c.var.membership },
        {
          platform: c.req.header("X-Client-Platform") ?? "unknown",
          ...(c.req.header("X-Client-Version")
            ? { appVersion: c.req.header("X-Client-Version")! }
            : {}),
        },
      ),
    );
  }),
];
