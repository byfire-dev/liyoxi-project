import { adminMediaJobList, adminMediaJobRetry } from "@liyoxi/contract";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
export const adminMediaJobHandlers = [
  defineAdminHandler(adminMediaJobList, { module: "system", need: "view" }, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.media.jobAdmin.list(staff.ctx, c.req.valid("query")));
  }),
  defineAdminHandler(adminMediaJobRetry, null, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    const identity = c.var.identity;
    if (!identity) throw new Error("媒体运维缺少身份上下文");
    return ok(
      c,
      await c.var.runtime.media.jobAdmin.retry(
        {
          staff: staff.ctx,
          identity,
          meta: {
            requestId: identity.requestId,
            ip: identity.ip,
            userAgent: identity.userAgent,
            sessionId: staff.principal.session.id,
            authMethod:
              staff.principal.session.authMethod === "password+totp"
                ? "password+totp"
                : staff.principal.session.authMethod === "password+recovery"
                  ? "password+recovery"
                  : null,
          },
        },
        c.req.valid("param").mediaJobId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
];
