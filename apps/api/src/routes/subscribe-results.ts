import { mSubscribeResultCreate, SubscribeResultOutcomeSchema } from "@liyoxi/contract";
import { ok } from "../http/errors.js";
import { idemOf } from "../http/idempotency.js";
import { merchantSessionOf } from "../http/merchant-auth.js";
import { defineHandler } from "../routing/define.js";
export const subscribeResultHandlers = [
  defineHandler(mSubscribeResultCreate, async (c) => {
    const result = await c.var.runtime.subscribeResults.apply(
      merchantSessionOf(c),
      c.req.valid("json"),
      { idem: idemOf(c) },
    );
    return ok(c, SubscribeResultOutcomeSchema.parse(result));
  }),
];
