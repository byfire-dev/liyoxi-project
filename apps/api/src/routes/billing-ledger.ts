import { mPointLedgerEntryList } from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import { ok } from "../http/errors.js";
import { defineHandler } from "../routing/define.js";

export const billingLedgerHandlers = [
  defineHandler(mPointLedgerEntryList, async (c) => {
    if (!c.var.identity || !c.var.membership) throw new AppError("AUTH_REQUIRED");
    return ok(
      c,
      await c.var.runtime.billing.accounts.merchantLedger(
        { ctx: c.var.identity, membership: c.var.membership },
        c.req.valid("query"),
      ),
    );
  }),
];
