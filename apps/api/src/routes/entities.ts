import { MembershipResultSchema, mEntityCreate } from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import { idemOf } from "../http/idempotency.js";
import { respondByRole } from "../http/respond-by-role.js";
import { merchantServicesOf } from "../merchant/services.js";
import { defineHandler } from "../routing/define.js";

export const entityHandlers = [
  defineHandler(mEntityCreate, async (c) => {
    const ctx = c.get("identity");
    if (ctx === undefined) throw new AppError("AUTH_REQUIRED");
    const result = await merchantServicesOf(c.var.runtime).tenant.createEntity(ctx, {
      idem: idemOf(c),
    });
    c.header("Cache-Control", "no-store");
    return respondByRole(
      c,
      { owner: MembershipResultSchema, clerk: MembershipResultSchema },
      result,
    );
  }),
];
