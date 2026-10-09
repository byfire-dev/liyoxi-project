import { assertAccess, hasPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { IdentityContext } from "../kernel/index.js";
import type { AuditRequestMeta } from "../audit/index.js";
export interface AgreementActor {
  readonly staff: StaffContext;
  readonly identity: IdentityContext;
  readonly meta: AuditRequestMeta;
}
export function assertAgreementEdit(actor: AgreementActor): void {
  assertAccess(actor.staff, { module: { module: "ops", need: "edit" }, permission: null });
  if (actor.identity.actor.type !== "staff" || actor.identity.actor.id !== actor.staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
}
export function canAgreementEdit(actor: AgreementActor): boolean {
  return actor.staff.moduleLevels.ops === "e";
}
export function mayRevealConsents(actor: AgreementActor): boolean {
  return hasPermission(actor.staff, "docs.consent.evidence");
}

export function assertAgreementView(actor: AgreementActor): void {
  assertAccess(actor.staff, { module: { module: "ops", need: "view" }, permission: null });
  if (actor.identity.actor.type !== "staff" || actor.identity.actor.id !== actor.staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
}
