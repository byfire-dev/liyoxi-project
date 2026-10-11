import { timingSafeEqual } from "node:crypto";
import { InvitationAcceptBodySchema, InvitationIdParamsSchema } from "@liyoxi/contract";
import type { InvitationAcceptBody, MembershipResult } from "@liyoxi/contract";
import type { Assembly, IdentityContext, Tx } from "../kernel/index.js";
import {
  AppError,
  createIdentityContext,
  createThreePhaseRunner,
  isUniqueViolation,
  lockRows,
  uuidv7,
} from "../kernel/index.js";
import type { Guard } from "../flow/index.js";
import type { Events } from "../events/index.js";
import { record as recordAudit } from "../audit/index.js";
import type {
  InvitationOptions,
  InvitationPrincipal,
  InvitationUseCaseDeps,
} from "./invitations.js";
import { invitationHash } from "./invitation-repo.js";
import { abandonDraftIn, emptyDraftFacts } from "./empty-draft.js";
import { selectActiveMembership } from "./repo.js";
import { resolveMembership } from "./membership.js";

interface Deps extends InvitationUseCaseDeps {
  readonly assembly: Pick<Assembly, "port">;
  readonly events?: Pick<Events, "emit">;
}
interface Receipt {
  readonly invitationId: string;
  readonly merchantUserId: string;
  readonly memberId: string;
  readonly abandonedEntityId: string | null;
  readonly isNew: boolean;
  readonly nonce: string;
}
type Input = InvitationAcceptBody & { readonly invitationId: string };
interface Prepared {
  readonly deps: Deps;
  readonly ctx: IdentityContext;
  readonly system: IdentityContext;
  readonly principal: InvitationPrincipal;
  readonly input: Input;
  readonly entityId: string;
  readonly storeId: string;
  readonly old: { entityId: string; ownerId: string; userId: string; storeIds: string[] } | null;
  memberId: string;
  phase: "abandon" | "join" | "accept";
}
// 只有真实 owner 的 settle 在完整锁后签发，guard/flow args 都不能签发权限。
const prepared = new WeakMap<Tx, Prepared>();
const sameIds = (a: readonly string[], b: readonly string[]) => a.join(",") === b.join(",");
const sorted = (ids: readonly string[]) => [...new Set(ids)].sort();
const wrongEntity = (role: string): never => {
  throw new AppError("PHONE_IN_OTHER_ENTITY", { details: { currentRole: role } });
};
function tokenMatches(row: { tokenHash: Uint8Array } | null, token: string) {
  const hash = invitationHash(token);
  if (!row || row.tokenHash.byteLength !== hash.byteLength || !timingSafeEqual(row.tokenHash, hash))
    throw new AppError("INVITATION_INVALID");
}
async function target(tx: Tx, state: Pick<Prepared, "deps" | "principal" | "input">) {
  const { deps, principal, input } = state;
  const now = deps.clock.now();
  const ports = deps.invitations?.accept;
  if (!ports) throw new AppError("INTERNAL");
  await ports.assertSession(tx, principal, now);
  const row = await tx.invitation.findUnique({ where: { id: input.invitationId } });
  tokenMatches(row, input.token);
  if (!row) throw new AppError("INVITATION_INVALID");
  if (row.status === "accepted") {
    if (row.acceptedByUserId !== principal.merchantUserId) throw new AppError("INVITATION_USED");
    return row;
  }
  const [entity, store, inviter, user] = await Promise.all([
    tx.entity.findUnique({ where: { id: row.entityId } }),
    tx.store.findUnique({ where: { id: row.storeId } }),
    tx.entityMember.findUnique({
      where: { id: row.inviterMemberId },
      include: { merchantUser: true },
    }),
    tx.merchantUser.findUnique({ where: { id: principal.merchantUserId } }),
  ]);
  if (
    row.status === "revoked" ||
    entity?.lifecycle !== "active" ||
    store?.lifecycle !== "active" ||
    store.entityId !== row.entityId ||
    inviter?.entityId !== row.entityId ||
    inviter.status !== "active" ||
    inviter.role !== "owner" ||
    inviter.merchantUser.status !== "active"
  )
    throw new AppError("INVITATION_REVOKED");
  if (row.status === "expired" || row.expiresAt <= now) throw new AppError("INVITATION_EXPIRED");
  if (row.status !== "pending" || user?.status !== "active" || !user.phoneBidx)
    throw new AppError("SESSION_INVALID");
  if (row.targetPhoneBidx && !timingSafeEqual(row.targetPhoneBidx, user.phoneBidx))
    throw new AppError("INVITATION_NOT_FOR_YOU");
  return row;
}

/** 精确 same-Tx、原上下文和当前阶段；让位级联还核真正 abandoned 状态。 */
export const guardAccept: Guard = async (tx, facts) => {
  const state = prepared.get(tx);
  if (!state) return false;
  if (state.phase === "abandon") {
    const old = state.old;
    if (!old || facts.ctx !== state.system || facts.entityId !== old.entityId) return false;
    if (facts.event === "entity.abandon")
      return (
        facts.subjectId === old.entityId &&
        (await emptyDraftFacts(tx, state.deps.assembly, old.entityId, old.ownerId, old.userId))
      );
    const entity = await tx.entity.findUnique({ where: { id: old.entityId } });
    return (
      entity?.lifecycle === "abandoned" &&
      ((facts.event === "entity_member.cascade_remove" && facts.subjectId === old.ownerId) ||
        (facts.event === "store.archive_by_entity" && old.storeIds.includes(facts.subjectId)))
    );
  }
  if (facts.ctx !== state.ctx || facts.entityId !== state.entityId) return false;
  const invitation = await target(tx, state);
  if (
    invitation.status !== "pending" ||
    invitation.entityId !== state.entityId ||
    invitation.storeId !== state.storeId
  )
    return false;
  const member = await tx.entityMember.findUnique({ where: { id: state.memberId } });
  if (
    member?.status !== "active" ||
    member.entityId !== state.entityId ||
    member.merchantUserId !== state.principal.merchantUserId ||
    member.role !== "clerk"
  )
    return false;
  if (state.phase === "join")
    return (
      facts.event === "entity_member.join" &&
      facts.subjectId === state.memberId &&
      (await tx.entityMember.count({
        where: { merchantUserId: member.merchantUserId, status: "active", NOT: { id: member.id } },
      })) === 0
    );
  return (
    facts.event === "invitation.accept" &&
    facts.subjectId === invitation.id &&
    (await tx.storeMember.count({
      where: { entityMemberId: member.id, storeId: state.storeId, entityId: state.entityId },
    })) === 1
  );
};

async function graph(
  tx: Tx,
  invitation: {
    id: string;
    entityId: string;
    inviterMemberId: string;
    acceptedMemberId: string | null;
    storeId: string;
  },
  member: Awaited<ReturnType<typeof selectActiveMembership>>,
) {
  const oldId = member && member.entityId !== invitation.entityId ? member.entityId : null;
  const [invitations, members, stores] = await Promise.all([
    oldId ? tx.invitation.findMany({ where: { entityId: oldId }, select: { id: true } }) : [],
    oldId ? tx.entityMember.findMany({ where: { entityId: oldId }, select: { id: true } }) : [],
    oldId ? tx.store.findMany({ where: { entityId: oldId }, select: { id: true } }) : [],
  ]);
  return {
    invitations: sorted([invitation.id, ...invitations.map((r) => r.id)]),
    members: sorted([
      invitation.inviterMemberId,
      ...(invitation.acceptedMemberId ? [invitation.acceptedMemberId] : []),
      ...(member ? [member.memberId] : []),
      ...members.map((r) => r.id),
    ]),
    stores: sorted([invitation.storeId, ...stores.map((r) => r.id)]),
    oldStores: stores.map((r) => r.id).sort(),
  };
}

export function createInvitationAcceptor(deps: Deps) {
  return async (
    context: IdentityContext,
    input: Input,
    options: InvitationOptions = {},
  ): Promise<MembershipResult> => {
    const principal = options.principal && Object.freeze({ ...options.principal });
    if (
      context.actor.type !== "merchant" ||
      context.actor.client !== "weapp" ||
      !principal ||
      principal.merchantUserId !== context.actor.id
    )
      throw new AppError("AUTH_REQUIRED");
    if (options.idem?.mode !== "required")
      throw new TypeError("接受邀请必须使用 required 幂等上下文");
    const { invitationId, ...payload } = input;
    const parsed = InvitationAcceptBodySchema.safeParse(payload);
    if (!InvitationIdParamsSchema.safeParse({ invitationId }).success)
      throw new AppError("VALIDATION_FAILED");
    if (!parsed.success)
      throw new AppError("VALIDATION_FAILED", {
        details: {
          fieldErrors: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    const body = Object.freeze({ ...parsed.data, invitationId: input.invitationId });
    const ctx = createIdentityContext({ ...context, actor: context.actor });
    const ports = deps.invitations?.accept;
    if (!ports || !deps.events || !deps.invitations) throw new AppError("INTERNAL");
    let receipt: Receipt;
    try {
      receipt = await createThreePhaseRunner(deps).run<Receipt, void, { completed: boolean }>(
        {
          async claim(tx) {
            const row = await target(tx, { deps, principal, input: body });
            return { completed: row.status === "accepted" };
          },
          async external(intent) {
            if (!intent.completed && body.displayName)
              await ports.checkName(principal, body.displayName);
          },
          async settle(tx) {
            if (prepared.has(tx)) throw new TypeError("接受邀请不能重入");
            await lockRows(tx, "merchant_user", [principal.merchantUserId], "update");
            const candidate = await tx.invitation.findUnique({ where: { id: body.invitationId } });
            tokenMatches(candidate, body.token);
            if (!candidate) throw new AppError("INVITATION_INVALID");
            let member = await selectActiveMembership(tx, principal.merchantUserId);
            const entities = sorted([candidate.entityId, ...(member ? [member.entityId] : [])]);
            await lockRows(tx, "entity", entities);
            const row = await tx.invitation.findUniqueOrThrow({ where: { id: candidate.id } });
            const current = await selectActiveMembership(tx, principal.merchantUserId);
            if (
              row.entityId !== candidate.entityId ||
              current?.memberId !== member?.memberId ||
              !sameIds(entities, sorted([row.entityId, ...(current ? [current.entityId] : [])]))
            )
              throw new AppError("PRECONDITION_CHANGED");
            const plan = await graph(tx, row, member);
            await lockRows(tx, "invitation", plan.invitations);
            await lockRows(tx, "entity_member", plan.members);
            await lockRows(tx, "store", plan.stores);
            const locked = await graph(
              tx,
              row,
              await selectActiveMembership(tx, principal.merchantUserId),
            );
            if (
              !sameIds(plan.invitations, locked.invitations) ||
              !sameIds(plan.members, locked.members) ||
              !sameIds(plan.stores, locked.stores)
            )
              throw new AppError("PRECONDITION_CHANGED");
            const invitation = await target(tx, { deps, principal, input: body });
            if (invitation.status === "accepted") {
              if (!invitation.acceptedMemberId) throw new AppError("NOT_A_MEMBER");
              return {
                invitationId: invitation.id,
                merchantUserId: principal.merchantUserId,
                memberId: invitation.acceptedMemberId,
                abandonedEntityId: null,
                isNew: false,
                nonce: uuidv7(),
              };
            }
            const user = await tx.merchantUser.findUniqueOrThrow({
              where: { id: principal.merchantUserId },
            });
            const name = body.displayName ?? user.displayName?.trim();
            if (!name)
              throw new AppError("VALIDATION_FAILED", {
                details: {
                  fieldErrors: [{ path: "displayName", message: "请填写加入门店的称呼" }],
                },
              });
            if (member?.entityId === invitation.entityId && member.role === "owner")
              throw new AppError("ALREADY_OWNER");
            const old =
              member && member.entityId !== invitation.entityId
                ? {
                    entityId: member.entityId,
                    ownerId: member.memberId,
                    userId: principal.merchantUserId,
                    storeIds: plan.oldStores,
                  }
                : null;
            if (
              old &&
              (member?.role !== "owner" ||
                !(await emptyDraftFacts(tx, deps.assembly, old.entityId, old.ownerId, old.userId)))
            )
              wrongEntity(member!.role);
            const state: Prepared = {
              deps,
              ctx,
              principal,
              input: body,
              entityId: invitation.entityId,
              storeId: invitation.storeId,
              old,
              memberId: member?.memberId ?? uuidv7(),
              phase: "abandon",
              system: createIdentityContext({
                actor: { type: "system", job: "tenant.acceptInvitation" },
                entityId: old?.entityId ?? null,
                requestId: ctx.requestId,
              }),
            };
            prepared.set(tx, state);
            try {
              if (old) {
                await abandonDraftIn(tx, deps, state.system, old, deps.clock.now());
                member = null;
              }
              const now = deps.clock.now();
              const isNew = member === null;
              state.phase = "join";
              if (isNew) {
                state.memberId = uuidv7();
                await tx.entityMember.create({
                  data: {
                    id: state.memberId,
                    entityId: state.entityId,
                    merchantUserId: principal.merchantUserId,
                    role: "clerk",
                    status: "active",
                    displayName: name,
                    lastStoreId: state.storeId,
                    invitationId: invitation.id,
                    invitedByMemberId: invitation.inviterMemberId,
                    createdAt: now,
                    updatedAt: now,
                  },
                });
                await deps.flow.transition(tx, ctx, {
                  machine: "entity_member",
                  stateField: "status",
                  id: state.memberId,
                  entityId: state.entityId,
                  storeId: state.storeId,
                  event: "entity_member.join",
                  ref: "02:691",
                  created: true,
                  emit: {
                    type: "entity_member.joined",
                    payload: {
                      v: 1,
                      entityMemberId: state.memberId,
                      entityId: state.entityId,
                      merchantUserId: principal.merchantUserId,
                      invitationId: invitation.id,
                      storeIds: [state.storeId],
                    },
                  },
                });
              }
              const added = await tx.storeMember.createMany({
                skipDuplicates: true,
                data: [
                  {
                    entityMemberId: state.memberId,
                    storeId: state.storeId,
                    entityId: state.entityId,
                    addedByMemberId: invitation.inviterMemberId,
                    createdAt: now,
                  },
                ],
              });
              if (!isNew && added.count) {
                await recordAudit(
                  tx,
                  ctx.actor,
                  {
                    requestId: ctx.requestId,
                    ip: ctx.ip,
                    userAgent: ctx.userAgent,
                    authMethod: null,
                    sessionId: null,
                  },
                  {
                    stream: "activity",
                    category: "member",
                    action: "tenant.member.accept_store",
                    summary: "接受邀请加入门店",
                    target: { type: "entity_member", id: state.memberId },
                    entityId: state.entityId,
                    storeId: state.storeId,
                    after: { addedStoreIds: [state.storeId] },
                  },
                );
                await deps.events!.emit(tx, ctx, {
                  type: "entity_member.stores_changed",
                  aggregate: { type: "entity_member", id: state.memberId },
                  entityId: state.entityId,
                  storeId: state.storeId,
                  payload: {
                    v: 1,
                    entityMemberId: state.memberId,
                    entityId: state.entityId,
                    merchantUserId: principal.merchantUserId,
                    addedStoreIds: [state.storeId],
                    removedStoreIds: [],
                    invitationId: invitation.id,
                  },
                });
              }
              state.phase = "accept";
              await deps.flow.transition(tx, ctx, {
                machine: "invitation",
                stateField: "status",
                id: invitation.id,
                entityId: state.entityId,
                storeId: state.storeId,
                event: "invitation.accept",
                ref: "02:787",
                set: {
                  accepted_at: now,
                  accepted_by_user_id: principal.merchantUserId,
                  accepted_member_id: state.memberId,
                  token_enc: null,
                },
                emit: {
                  type: "invitation.accepted",
                  payload: {
                    v: 1,
                    invitationId: invitation.id,
                    entityId: state.entityId,
                    storeId: state.storeId,
                    acceptedByUserId: principal.merchantUserId,
                  },
                },
              });
              await deps.invitations!.timers.cancel(tx, {
                subject: { type: "invitation", id: invitation.id },
                kinds: ["invitation.expire"],
              });
              if (user.displayName === null)
                await tx.merchantUser.update({
                  where: { id: user.id },
                  data: { displayName: name, updatedAt: now },
                });
              return {
                invitationId: invitation.id,
                merchantUserId: principal.merchantUserId,
                memberId: state.memberId,
                abandonedEntityId: old?.entityId ?? null,
                isNew,
                nonce: uuidv7(),
              };
            } finally {
              prepared.delete(tx);
            }
          },
        },
        options,
      );
    } catch (error) {
      if (isUniqueViolation(error, ["uq_entity_member_one_entity"])) {
        const current = await deps.tx.run((tx) =>
          selectActiveMembership(tx, principal.merchantUserId),
        );
        if (current) wrongEntity(current.role);
      }
      throw error;
    }
    // 幂等缓存只存私有收据；每次成功包括同键重放都读取当前实际成员，不复活历史关系。
    return deps.tx.run(async (tx) => {
      const invitation = await target(tx, { deps, principal, input: body });
      if (
        receipt.invitationId !== invitation.id ||
        receipt.merchantUserId !== principal.merchantUserId ||
        receipt.memberId !== invitation.acceptedMemberId
      )
        throw new AppError("NOT_A_MEMBER");
      const store = await tx.store.findUnique({ where: { id: invitation.storeId } });
      if (store?.lifecycle !== "active") throw new AppError("STORE_ARCHIVED");
      const current = await resolveMembership(tx, {
        merchantUserId: principal.merchantUserId,
        storeId: invitation.storeId,
      });
      if (!current || current.memberId !== receipt.memberId) throw new AppError("NOT_A_MEMBER");
      return {
        entityId: current.entityId,
        memberId: current.memberId,
        role: current.role,
        storeId: current.storeId,
        isNew: receipt.isNew,
        abandonedEntityId: receipt.abandonedEntityId,
      };
    });
  };
}
