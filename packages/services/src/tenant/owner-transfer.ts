import type { Flow, Guard } from "../flow/index.js";
import { AppError, createIdentityContext, lockRows, uuidv7 } from "../kernel/index.js";
import type { Assembly, Clock, IdentityContext, Tx } from "../kernel/index.js";
import { blindIndex, decryptField } from "../security/index.js";
import type { Keyring } from "../security/index.js";
import { membershipAuthorizationsPort } from "./ports.js";

interface Deps {
  flow: Flow;
  clock: Clock;
  assembly: Pick<Assembly, "port">;
  keyring: () => Keyring;
}
export interface OwnerTransferInput {
  accountChangeRequestId: string;
  newOwnerUserId: string;
}
export interface OwnerTransferResult {
  newOwnerMemberId: string;
  prevOwnerMemberId: string;
}
type Prepared = {
  deps: Deps;
  ctx: IdentityContext;
  input: OwnerTransferInput;
  entityId: string;
  oldId: string;
  newId: string;
  oldUserId: string;
};
const prepared = new WeakMap<Tx, Prepared>();
async function authorized(tx: Tx, state: Prepared) {
  const request = await tx.accountChangeRequest.findUnique({
    where: { id: state.input.accountChangeRequestId },
    include: { approvalRequest: true },
  });
  const user = await tx.merchantUser.findUnique({ where: { id: state.input.newOwnerUserId } });
  const approval = request?.approvalRequest;
  if (
    state.ctx.actor.type !== "staff" ||
    state.ctx.actor.client !== "admin" ||
    !request ||
    request.kind !== "owner_transfer" ||
    request.entityId !== state.entityId ||
    request.appliedAt ||
    !request.newPhoneEnc ||
    approval?.kind !== "account_change" ||
    approval.status !== "approved" ||
    approval.decidedByStaffId !== state.ctx.actor.id ||
    !user?.phoneBidx ||
    user.status !== "active"
  )
    return false;
  const phone = decryptField(
    state.deps.keyring(),
    "account_change_request.new_phone_enc",
    request.newPhoneEnc,
  );
  if (!Buffer.from(user.phoneBidx).equals(blindIndex(state.deps.keyring(), "phone", phone)))
    return false;
  return (
    (await tx.entity.findUnique({ where: { id: state.entityId }, select: { lifecycle: true } }))
      ?.lifecycle === "active"
  );
}
/** 只认同Tx真实审批生效调用；输入布尔值和无关批准单都不能赋予成员迁移权。 */
export const guardOwnerTransfer: Guard = async (tx, facts) => {
  const state = prepared.get(tx);
  if (
    !state ||
    facts.ctx !== state.ctx ||
    facts.entityId !== state.entityId ||
    !(await authorized(tx, state))
  )
    return false;
  const member = await tx.entityMember.findUnique({ where: { id: facts.subjectId } });
  if (facts.event === "entity_member.cascade_remove")
    return (
      facts.subjectId === state.oldId &&
      member?.merchantUserId === state.oldUserId &&
      member.status === "active" &&
      member.role === "owner"
    );
  if (
    facts.subjectId !== state.newId ||
    member?.merchantUserId !== state.input.newOwnerUserId ||
    member.entityId !== state.entityId ||
    member.status !== "active"
  )
    return false;
  const old = await tx.entityMember.findUnique({ where: { id: state.oldId } });
  if (old?.status !== "removed" || old.removeReason !== "owner_transfer") return false;
  return facts.event === "entity_member.promote_owner"
    ? member.role === "clerk"
    : facts.event === "entity_member.create_owner" && member.role === "owner";
};

/** 身份域已预锁审批30/申请40及账号80全集；本域拥有成员迁移与授权吊销。 */
export async function transferOwnerIn(
  tx: Tx,
  deps: Deps,
  ctx: IdentityContext,
  input: OwnerTransferInput,
): Promise<OwnerTransferResult> {
  if (prepared.has(tx)) throw new AppError("INTERNAL");
  const request = await tx.accountChangeRequest.findUnique({
    where: { id: input.accountChangeRequestId },
  });
  if (!request?.entityId) throw new AppError("PRECONDITION_CHANGED");
  const first = await tx.entityMember.findFirst({
    where: { entityId: request.entityId, status: "active", role: "owner" },
  });
  if (!first || first.merchantUserId === input.newOwnerUserId)
    throw new AppError("PRECONDITION_CHANGED");
  await lockRows(tx, "merchant_user", [first.merchantUserId, input.newOwnerUserId].sort());
  await lockRows(tx, "entity", [request.entityId]);
  const candidate = await tx.entityMember.findFirst({
    where: { merchantUserId: input.newOwnerUserId, status: "active" },
  });
  if (candidate && candidate.entityId !== request.entityId)
    throw new AppError("PRECONDITION_CHANGED", {
      details: { reason: "new_owner_in_other_entity" },
    });
  await lockRows(tx, "entity_member", [first.id, ...(candidate ? [candidate.id] : [])].sort());
  const old = await tx.entityMember.findUniqueOrThrow({ where: { id: first.id } });
  if (old.status !== "active" || old.role !== "owner" || old.entityId !== request.entityId)
    throw new AppError("PRECONDITION_CHANGED");
  const effective = createIdentityContext({
    ...ctx,
    actor: ctx.actor,
    entityId: request.entityId,
    storeId: null,
  });
  const state: Prepared = {
    deps,
    ctx: effective,
    input,
    entityId: request.entityId,
    oldId: old.id,
    newId: candidate?.id ?? uuidv7(),
    oldUserId: old.merchantUserId,
  };
  if (!(await authorized(tx, state))) throw new AppError("PRECONDITION_CHANGED");
  prepared.set(tx, state);
  try {
    const now = deps.clock.now(),
      audit = { mergedInto: { approvalRequestId: request.approvalRequestId } };
    await deps.flow.transition(tx, effective, {
      machine: "entity_member",
      stateField: "status",
      id: old.id,
      event: "entity_member.cascade_remove",
      ref: "02:694",
      entityId: state.entityId,
      reasonCode: "owner_transfer",
      set: {
        removed_at: now,
        remove_actor_type: "staff",
        remove_actor_id: ctx.actor.id,
        remove_client: "admin",
        remove_reason: "owner_transfer",
        last_store_id: null,
      },
      audit,
      emit: {
        type: "entity_member.removed",
        payload: {
          v: 1,
          entityMemberId: old.id,
          entityId: state.entityId,
          merchantUserId: old.merchantUserId,
          role: "owner",
          removeReason: "owner_transfer",
        },
      },
    });
    await tx.storeMember.deleteMany({ where: { entityMemberId: old.id } });
    await deps.assembly.port(membershipAuthorizationsPort).revokePortalGrants(tx, {
      scope: "owner",
      merchantUserId: old.merchantUserId,
      entityId: state.entityId,
      now,
    });
    if (!candidate) {
      const newUser = await tx.merchantUser.findUniqueOrThrow({
        where: { id: input.newOwnerUserId },
      });
      await tx.entityMember.create({
        data: {
          id: state.newId,
          entityId: state.entityId,
          merchantUserId: input.newOwnerUserId,
          role: "owner",
          status: "active",
          displayName: newUser.displayName,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    await deps.flow.transition(tx, effective, {
      machine: "entity_member",
      stateField: "status",
      id: state.newId,
      event: candidate ? "entity_member.promote_owner" : "entity_member.create_owner",
      ref: candidate ? "02:693" : "02:690",
      ...(candidate ? { set: { role: "owner", last_store_id: null } } : { created: true }),
      entityId: state.entityId,
      audit,
      emit: {
        type: "entity_member.promoted",
        payload: {
          v: 1,
          entityMemberId: state.newId,
          entityId: state.entityId,
          merchantUserId: input.newOwnerUserId,
        },
      },
    });
    await tx.storeMember.deleteMany({ where: { entityMemberId: state.newId } });
    return { newOwnerMemberId: state.newId, prevOwnerMemberId: old.id };
  } finally {
    prepared.delete(tx);
  }
}
