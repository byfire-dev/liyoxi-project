import type { AuditAction } from "@liyoxi/contract";
import type { Staff } from "@liyoxi/db";
import { record } from "../audit/index.js";
import { AppError } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { lockStaff } from "./repo.js";

export async function staffAudit(
  tx: Tx,
  actor: IdentityContext,
  row: Staff,
  action: AuditAction,
  summary: string,
  change?: { before: object; after: object; fields: readonly string[] },
  meta?: Record<string, unknown>,
) {
  await record(
    tx,
    actor.actor,
    {
      requestId: actor.requestId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      sessionId: null,
      authMethod: null,
      ...(actor.actor.client === "cli" ? { jobName: "cli.staff_reissue_activation" } : {}),
    },
    {
      stream: "ops",
      category:
        action === "sys.session.revoke" || action.includes("reset") || action === "sys.staff.unlock"
          ? "account_security"
          : "staff_authz",
      action,
      summary,
      target: { type: "staff", id: row.id, label: row.name },
      entityId: null,
      storeId: null,
      ...(change ?? { before: null, after: null, fields: [] }),
      ...(meta ? { meta } : {}),
    },
  );
}
export async function locked(tx: Tx, id: string) {
  const row = await lockStaff(tx, id);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}
export async function lockStaffSet(tx: Tx, ids: readonly string[]) {
  const rows = new Map<string, Staff>();
  for (const id of [...new Set(ids)].sort()) rows.set(id, await locked(tx, id));
  return rows;
}

export const assignmentContactTimerKey = (id: string) => `sla.breach:assignment_history:${id}`;
