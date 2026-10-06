import { adminRoleList, RoleSummaryListSchema } from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { defineAdminHandler } from "../../routing/admin.js";
import { staffManagementOf } from "./staff.js";

export const adminRoleHandlers = [
  defineAdminHandler(adminRoleList, { module: "system", need: "view" }, async (c, current) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      RoleSummaryListSchema.parse(await staffManagementOf(c.var.runtime).roles(current.ctx)),
    );
  }),
];
