import type { AccountChangeCreateBody } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { entityScope } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { paramsAt } from "../config/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { blindIndex, decryptField } from "../security/index.js";
import type { AccountChangeDeps } from "./account-change-context.js";

export const accountChangeInclude = {
  approvalRequest: true,
  merchantUser: true,
  entity: true,
} as const;
export type AccountChangeRow = Prisma.AccountChangeRequestGetPayload<{
  include: typeof accountChangeInclude;
}>;
export function accountChangeScope(staff: StaffContext): Prisma.AccountChangeRequestWhereInput {
  return staff.scope.kind === "all"
    ? {}
    : {
        OR: [
          { entityId: { not: null }, entity: entityScope(staff.scope) },
          { entityId: null, approvalRequest: { requesterStaffId: staff.staff.id } },
        ],
      };
}
export async function requestOf(
  tx: Tx,
  staff: StaffContext,
  id: string,
): Promise<AccountChangeRow> {
  const row = await tx.accountChangeRequest.findFirst({
    where: { AND: [{ id }, accountChangeScope(staff)] },
    include: accountChangeInclude,
  });
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}
export async function targetFacts(
  tx: Tx,
  input: Pick<AccountChangeCreateBody, "kind"> & {
    merchantUserId?: string | undefined;
    entityId?: string | undefined;
  },
) {
  const owner =
    input.kind === "owner_transfer"
      ? await tx.entityMember.findFirst({
          where: { entityId: input.entityId!, role: "owner", status: "active" },
          include: { merchantUser: true },
        })
      : null;
  const user =
    owner?.merchantUser ??
    (input.merchantUserId
      ? await tx.merchantUser.findUnique({ where: { id: input.merchantUserId } })
      : null);
  const member =
    input.kind === "owner_transfer"
      ? owner
      : user
        ? await tx.entityMember.findFirst({ where: { merchantUserId: user.id, status: "active" } })
        : null;
  const entityId = input.kind === "owner_transfer" ? input.entityId! : (member?.entityId ?? null);
  const entity = entityId ? await tx.entity.findUnique({ where: { id: entityId } }) : null;
  return { user, member, entity, entityId };
}
export async function visibleTarget(
  tx: Tx,
  staff: StaffContext,
  input: Parameters<typeof targetFacts>[1],
) {
  const facts = await targetFacts(tx, input);
  if (
    !facts.user ||
    (facts.entityId
      ? !(await tx.entity.findFirst({
          where: { id: facts.entityId, ...entityScope(staff.scope) },
          select: { id: true },
        }))
      : staff.scope.kind !== "all")
  )
    throw new AppError("NOT_FOUND");
  return facts;
}
export async function precheck(
  tx: Tx,
  deps: AccountChangeDeps,
  input: Parameters<typeof targetFacts>[1] & { newPhone?: string | undefined },
) {
  const facts = await targetFacts(tx, input),
    issues: string[] = [],
    now = deps.clock.now();
  if (facts.user?.status !== "active") issues.push("target_not_active");
  if (facts.entityId && facts.entity?.lifecycle !== "active") issues.push("entity_not_active");
  if (input.kind === "owner_reverify") {
    const values = await paramsAt(tx, ["auth.dormant_days"], now);
    if (
      facts.member?.role !== "owner" ||
      !facts.user ||
      values["auth.dormant_days"] === 0 ||
      facts.user.lastActiveAt.getTime() >= now.getTime() - values["auth.dormant_days"] * 86400000 ||
      (facts.user.dormantBypassUntil && facts.user.dormantBypassUntil > now)
    )
      issues.push("target_not_active");
  }
  let occupant = null;
  if (input.newPhone) {
    occupant = await tx.merchantUser.findUnique({
      where: { phoneBidx: blindIndex(deps.keyring(), "phone", input.newPhone) },
    });
    if (input.kind === "phone_rebind" && occupant?.id !== facts.user?.id && occupant) {
      const history = await tx.entityMember.count({ where: { merchantUserId: occupant.id } });
      issues.push(
        occupant.status !== "active" || history ? "phone_taken" : "phone_occupied_by_empty_account",
      );
    }
    if (input.kind === "owner_transfer" && occupant) {
      const member = await tx.entityMember.findFirst({
        where: { merchantUserId: occupant.id, status: "active" },
      });
      if (occupant.status !== "active") issues.push("target_not_active");
      if (member && member.entityId !== input.entityId) issues.push("new_owner_in_other_entity");
      if (occupant.id === facts.user?.id) issues.push("target_not_active");
    }
  }
  return {
    ...facts,
    occupant,
    ok: issues.every((issue) => issue === "phone_occupied_by_empty_account"),
    issues: [...new Set(issues)],
  };
}
export function inputFor(row: AccountChangeRow, deps: AccountChangeDeps) {
  return {
    kind: row.kind as AccountChangeCreateBody["kind"],
    merchantUserId: row.merchantUserId ?? undefined,
    entityId: row.entityId ?? undefined,
    ...(row.newPhoneEnc
      ? {
          newPhone: decryptField(
            deps.keyring(),
            "account_change_request.new_phone_enc",
            row.newPhoneEnc,
          ),
        }
      : {}),
  };
}
export function checkIssue(result: Awaited<ReturnType<typeof precheck>>, approving: boolean): void {
  const reason = result.issues.find((issue) => issue !== "phone_occupied_by_empty_account");
  if (!reason) return;
  if (approving) throw new AppError("PRECONDITION_CHANGED", { details: { reason } });
  throw new AppError(
    reason === "phone_taken"
      ? "PHONE_TAKEN"
      : reason === "new_owner_in_other_entity"
        ? "PHONE_IN_OTHER_ENTITY"
        : "STATE_NOT_ALLOWED",
  );
}
