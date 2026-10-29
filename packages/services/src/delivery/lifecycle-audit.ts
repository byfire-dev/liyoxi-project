import { record } from "../audit/index.js";
import type { AuditEntry } from "../audit/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";

export function lifecycleAudit(tx: Tx, ctx: IdentityContext, entry: AuditEntry) {
  return record(
    tx,
    ctx.actor,
    {
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      sessionId: null,
      authMethod: null,
    },
    entry,
  );
}
