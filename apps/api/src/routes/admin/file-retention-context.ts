import type { IdentityContext, RequestMeta } from "@liyoxi/services";
import type { AdminStaff } from "../../routing/admin.js";

export function fileRetentionActor(identity: IdentityContext, staff: AdminStaff) {
  const meta: Pick<RequestMeta, "requestId" | "ip" | "userAgent"> & {
    sessionId: string;
    authMethod: "password+totp" | "password+recovery" | null;
  } = {
    requestId: identity.requestId,
    ip: identity.ip,
    userAgent: identity.userAgent,
    sessionId: staff.principal.session.id,
    authMethod:
      staff.principal.session.authMethod === "password+totp" ||
      staff.principal.session.authMethod === "password+recovery"
        ? staff.principal.session.authMethod
        : null,
  };
  return { identity, staff: staff.ctx, meta };
}
