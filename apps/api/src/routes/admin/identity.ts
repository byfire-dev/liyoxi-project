import {
  adminMerchantUserDisable,
  adminMerchantUserEnable,
  adminMerchantUserForceLogout,
} from "@liyoxi/contract";
import type { AuditRequestMeta } from "@liyoxi/services";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { merchantServicesOf } from "../../merchant/services.js";
import { defineAdminHandler } from "../../routing/admin.js";
import type { AdminStaff } from "../../routing/admin.js";

const metaOf = (
  staff: AdminStaff,
  identity: { requestId: string | null; ip: string | null; userAgent: string | null },
): AuditRequestMeta => ({
  ...identity,
  sessionId: staff.principal.session.id,
  authMethod:
    staff.principal.session.authMethod === "password+totp" ||
    staff.principal.session.authMethod === "password+recovery"
      ? staff.principal.session.authMethod
      : null,
});
export const adminIdentityHandlers = [
  defineAdminHandler(
    adminMerchantUserDisable,
    { module: "merchant", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await merchantServicesOf(c.var.runtime).identity.adminUserAction(
          c.var.identity!,
          staff.ctx,
          "disable",
          { ...c.req.valid("param"), ...c.req.valid("json") },
          { idem: idemOf(c), meta: metaOf(staff, c.var.identity!) },
        ),
      );
    },
  ),
  defineAdminHandler(
    adminMerchantUserEnable,
    { module: "merchant", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await merchantServicesOf(c.var.runtime).identity.adminUserAction(
          c.var.identity!,
          staff.ctx,
          "enable",
          { ...c.req.valid("param"), ...c.req.valid("json") },
          { idem: idemOf(c), meta: metaOf(staff, c.var.identity!) },
        ),
      );
    },
  ),
  defineAdminHandler(
    adminMerchantUserForceLogout,
    { module: "merchant", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await merchantServicesOf(c.var.runtime).identity.adminUserAction(
          c.var.identity!,
          staff.ctx,
          "forceLogout",
          { ...c.req.valid("param"), ...c.req.valid("json") },
          { idem: idemOf(c), meta: metaOf(staff, c.var.identity!) },
        ),
      );
    },
  ),
];
