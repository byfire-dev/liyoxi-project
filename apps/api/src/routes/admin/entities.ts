import { adminEntityGet, adminEntityMemberList } from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { merchantServicesOf } from "../../merchant/services.js";
import { defineAdminHandler } from "../../routing/admin.js";

const moduleNeed = { module: "merchant", need: "view" } as const;
export const adminEntityHandlers = [
  defineAdminHandler(adminEntityGet, moduleNeed, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await merchantServicesOf(c.var.runtime).tenant.adminEntityGet(
        staff.ctx,
        c.req.valid("param").entityId,
      ),
    );
  }),
  defineAdminHandler(adminEntityMemberList, moduleNeed, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await merchantServicesOf(c.var.runtime).tenant.adminEntityMemberList(
        staff.ctx,
        c.req.valid("param").entityId,
        c.req.valid("query"),
      ),
    );
  }),
];
