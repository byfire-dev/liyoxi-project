import { AccountChangeRequestCardSchema, AccountChangeRequestDetailSchema } from "@liyoxi/contract";
import type { AccountChangeRequestCard, AccountChangeRequestDetail } from "@liyoxi/contract";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { AccountChangeDeps } from "./account-change-context.js";
import { inputFor, precheck, targetFacts } from "./account-change-facts.js";
import type { AccountChangeRow } from "./account-change-facts.js";
const brief = (
  row: { id: string; displayName: string | null; phoneMask: string | null; status: string } | null,
) =>
  row
    ? {
        merchantUserId: row.id,
        displayName: row.displayName,
        phoneMask: row.phoneMask,
        status: row.status,
      }
    : null;
export async function accountChangeCard(
  tx: Tx,
  deps: AccountChangeDeps,
  staff: StaffContext,
  row: AccountChangeRow,
): Promise<AccountChangeRequestCard> {
  if (!deps.approval) throw new AppError("INTERNAL");
  const approval = await deps.approval.decisionView(tx, staff, row.approvalRequestId);
  const reason = await tx.dictItem.findUnique({
    where: { dictTypeKey_code: { dictTypeKey: "account_change_reason", code: row.reasonCode } },
    select: { name: true },
  });
  return AccountChangeRequestCardSchema.parse({
    accountChangeRequestId: row.id,
    kind: row.kind,
    requestNo: row.approvalRequest.requestNo,
    approval,
    target: brief(row.merchantUser),
    entity: row.entity ? { entityId: row.entity.id, name: row.entity.name } : null,
    newPhoneMask: row.newPhoneMask,
    reason: { code: row.reasonCode, name: reason?.name ?? row.reasonCode },
    reasonText: row.reasonText,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    actions: approval.actions.filter((action) =>
      ["approve", "reject", "withdraw"].includes(action),
    ),
  });
}
export async function accountChangeDetail(
  tx: Tx,
  deps: AccountChangeDeps,
  staff: StaffContext,
  row: AccountChangeRow,
): Promise<AccountChangeRequestDetail> {
  const pending = row.approvalRequest.status === "pending",
    input = inputFor(row, deps);
  const facts = row.kind === "owner_transfer" ? await targetFacts(tx, input) : null;
  const check = pending ? await precheck(tx, deps, input) : null;
  return AccountChangeRequestDetailSchema.parse({
    ...(await accountChangeCard(tx, deps, staff, row)),
    proofFileIds: row.proofFileIds,
    confirmChecks: row.approvalRequest.confirmChecks,
    verifyMethod: row.verifyMethod,
    verifyRecord: row.verifyRecord,
    currentOwner: facts ? brief(facts.user) : null,
    precheck: check ? { ok: check.ok, issues: check.issues } : null,
    result: row.resultSnapshot,
    createdAt: row.createdAt.toISOString(),
  });
}
