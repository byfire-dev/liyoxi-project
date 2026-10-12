import { adminEntityQuotaUpdate } from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { merchantServicesOf } from "../../merchant/services.js";
import { defineAdminHandler } from "../../routing/admin.js";

export const adminEntityQuotaHandlers = [
  defineAdminHandler(
    adminEntityQuotaUpdate,
    { module: "merchant", need: "view" },
    async (c, staff) => {
      const identity = c.var.identity!;
      const method = staff.principal.session.authMethod;
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await merchantServicesOf(c.var.runtime).tenant.updateEntityQuota(
          identity,
          staff.ctx,
          { entityId: c.req.valid("param").entityId, ...c.req.valid("json") },
          {
            idem: idemOf(c),
            meta: {
              requestId: identity.requestId,
              ip: identity.ip,
              userAgent: identity.userAgent,
              sessionId: staff.principal.session.id,
              authMethod:
                method === "password+totp" || method === "password+recovery" ? method : null,
            },
          },
        ),
      );
    },
  ),
];
