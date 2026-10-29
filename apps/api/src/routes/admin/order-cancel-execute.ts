import { adminCancelRequestExecute } from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";

export const adminOrderCancelExecuteHandlers = [
  defineAdminHandler(adminCancelRequestExecute, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.cancelRequests.execute(
        { ctx: c.var.identity!, staff: staff.ctx },
        c.req.valid("param").cancelRequestId,
        c.req.valid("json"),
        idemOf(c),
      ),
    );
  }),
];
