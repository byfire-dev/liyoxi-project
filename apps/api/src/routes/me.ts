import { CurrentStoreSchema, mMeCurrentStoreReplace } from "@liyoxi/contract";
import { idemOf } from "../http/idempotency.js";
import { merchantSessionOf } from "../http/merchant-auth.js";
import { respondByRole } from "../http/respond-by-role.js";
import { merchantServicesOf } from "../merchant/services.js";
import { defineHandler } from "../routing/define.js";

export const meHandlers = [
  defineHandler(mMeCurrentStoreReplace, async (c) => {
    const result = await merchantServicesOf(c.var.runtime).tenant.rememberCurrentStore(
      { merchantUserId: merchantSessionOf(c).merchantUserId, ...c.req.valid("json") },
      { idem: idemOf(c) },
    );
    c.header("Cache-Control", "no-store");
    return respondByRole(c, { owner: CurrentStoreSchema, clerk: CurrentStoreSchema }, result);
  }),
];
