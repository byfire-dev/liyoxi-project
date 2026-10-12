import { adminEntityClose } from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { merchantServicesOf } from "../../merchant/services.js";
import { defineAdminHandler } from "../../routing/admin.js";

export const adminEntityCloseHandlers = [
  defineAdminHandler(adminEntityClose, { module: "merchant", need: "view" }, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await merchantServicesOf(c.var.runtime).tenant.closeEntity(
        c.var.identity!,
        staff.ctx,
        { entityId: c.req.valid("param").entityId, ...c.req.valid("json") },
        { idem: idemOf(c) },
      ),
    );
  }),
];
