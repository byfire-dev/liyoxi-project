import type { PendingBillingCancel } from "@liyoxi/contract";
import { assertPermission, byEntity } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import type { PermissionKey } from "@liyoxi/contract/authz";
import type { Approval } from "../../approval/index.js";
import { AppError } from "../../kernel/index.js";
import type { Clock, IdentityContext, Tx, TxRunner } from "../../kernel/index.js";
import type { Events } from "../../events/index.js";
import type { Ledger } from "../ledger/index.js";

export interface BillingApprovalRefs {
  prepare(tx: Tx, input: { serviceTicketId: string; entityId: string }): Promise<void>;
  attach(
    tx: Tx,
    input: { serviceTicketId: string; entityId: string; approvalRequestId: string },
  ): Promise<void>;
  list(
    tx: Tx,
    input: { entityId: string; approvalRequestId: string },
  ): Promise<{ serviceTicketId: string; ticketNo: string }[]>;
}
export interface BillingAdjustmentDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly events: Pick<Events, "emit">;
  readonly approval: Approval;
  readonly ledger: Ledger;
  readonly refs: BillingApprovalRefs;
  readonly pendingCancels: (tx: Tx, entityId: string) => Promise<PendingBillingCancel[]>;
}
export interface AdjustmentActor {
  readonly identity: IdentityContext;
  readonly staff: StaffContext;
}

export function assertAdjustmentActor(
  deps: Pick<BillingAdjustmentDeps, "clock">,
  actor: AdjustmentActor,
  permission?: PermissionKey,
) {
  if (actor.identity.actor.type !== "staff" || actor.identity.actor.id !== actor.staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  if (permission) assertPermission(actor.staff, permission, deps.clock.now());
}
export async function adjustmentAccountInScope(tx: Tx, staff: StaffContext, entityId: string) {
  const account = await tx.billingAccount.findFirst({
    where: { entityId, ...byEntity(staff.scope) },
  });
  if (!account) throw new AppError("NOT_FOUND");
  return account;
}
