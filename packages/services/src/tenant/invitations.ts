// 四个邀请卡片入口：自然请求绑定、事务外检测与原状态机同事务副作用。
import { InvitationCreateBodySchema } from "@liyoxi/contract";
import type {
  InvitationCreateBody,
  InvitationRevokeBody,
  InvitationRevokeResult,
} from "@liyoxi/contract";
import { calendarDate, dayRange } from "@liyoxi/shared/time";
import { record as recordAudit } from "../audit/index.js";
import { paramsAt } from "../config/index.js";
import type { Flow, Guard } from "../flow/index.js";
import { AppError, createThreePhaseRunner, uuidv7 } from "../kernel/index.js";
import type {
  Clock,
  IdentityContext,
  MerchantFactsReader,
  ThreePhaseRunOptions,
  Tx,
  TxRunner,
} from "../kernel/index.js";
import type { Keyring } from "../security/index.js";
import type { Timers } from "../timers/index.js";
import {
  invitationBinding,
  invitationCard,
  invitationFields,
  invitationRows,
  invitationViewer,
  lockInvitationContext,
  newInvitationToken,
} from "./invitation-repo.js";
import { quotaWithSubscription } from "./quota.js";

export interface InvitationPrincipal {
  readonly sessionId: string;
  readonly merchantUserId: string;
  readonly wechatIdentityId: string;
  readonly consentStamp: string | null;
}
export interface InvitationDeps {
  readonly keyring: () => Keyring;
  readonly timers: Pick<Timers, "arm" | "cancel">;
  readonly checkRemark: (principal: InvitationPrincipal, text: string) => Promise<void>;
  /** 接受邀请由组合根接真实会话事实；旧卡片入口不要求这项装配。 */
  readonly accept?: {
    assertSession(tx: Tx, principal: InvitationPrincipal, now: Date): Promise<InvitationPrincipal>;
    checkName(principal: InvitationPrincipal, text: string): Promise<void>;
  };
}
export interface InvitationOptions extends ThreePhaseRunOptions {
  readonly principal?: InvitationPrincipal;
}
export interface InvitationUseCaseDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly flow: Flow;
  readonly facts: MerchantFactsReader;
  readonly invitations?: InvitationDeps;
}
const configured = (deps: InvitationUseCaseDeps) => {
  if (!deps.invitations) throw new AppError("INTERNAL");
  return deps.invitations;
};
const invalidPhone = (): never => {
  throw new AppError("VALIDATION_FAILED", {
    details: { fieldErrors: [{ path: "targetPhone", message: "请填写定向手机号" }] },
  });
};
async function newInvitationAllowed(
  tx: Tx,
  deps: InvitationUseCaseDeps,
  now: Date,
  entityId: string,
  inserted = false,
) {
  const { usage } = await quotaWithSubscription(tx, deps, now, entityId);
  if (usage.memberLimit !== null && usage.seatsUsed + (inserted ? 0 : 1) > usage.memberLimit)
    throw new AppError("SEAT_LIMIT_REACHED", {
      details: {
        seatsUsed: usage.seatsUsed,
        memberLimit: usage.memberLimit,
        limitReason: usage.limitReason,
      },
    });
  const params = await paramsAt(tx, ["invitation.daily_cap"], now);
  const { start, end } = dayRange(calendarDate(now));
  const count = await tx.invitation.count({
    where: { entityId, status: { not: "revoked" }, createdAt: { gte: start, lt: end } },
  });
  if (count + (inserted ? 0 : 1) > params["invitation.daily_cap"])
    throw new AppError("INVITATION_DAILY_LIMIT", {
      details: { dailyCap: params["invitation.daily_cap"] },
    });
}

// 只允许已经完成完整预锁的真实拥有者迁移；不能用伪造 args 直调 flow。
const prepared = new WeakMap<
  Tx,
  {
    ctx: IdentityContext;
    id: string;
    memberId: string;
    event: "invitation.create" | "invitation.revoke";
    deps: InvitationUseCaseDeps;
  }
>();
export const guardInvitation: Guard = async (tx, facts) => {
  const bound = prepared.get(tx);
  if (
    !bound ||
    bound.ctx !== facts.ctx ||
    bound.id !== facts.subjectId ||
    bound.event !== facts.event
  )
    return false;
  const viewer = await invitationViewer(tx, bound.ctx);
  const row = await tx.invitation.findUnique({ where: { id: bound.id } });
  if (
    !row ||
    row.status !== "pending" ||
    row.entityId !== viewer.entityId ||
    row.storeId !== viewer.storeId ||
    facts.entityId !== viewer.entityId ||
    facts.storeId !== viewer.storeId ||
    viewer.memberId !== bound.memberId
  )
    return false;
  if (bound.event === "invitation.create") {
    if (row.inviterMemberId !== viewer.memberId || row.expiresAt <= bound.deps.clock.now())
      return false;
    await newInvitationAllowed(tx, bound.deps, bound.deps.clock.now(), viewer.entityId, true);
  }
  return true;
};

async function scheduleInvitation(
  tx: Tx,
  timers: InvitationDeps["timers"],
  row: {
    id: string;
    entityId: string;
    storeId: string;
    expiresAt: Date;
  },
) {
  const input = {
    kind: "invitation.expire",
    subject: { type: "invitation", id: row.id },
    key: `invitation.expire:invitation:${row.id}`,
    fireAt: row.expiresAt,
    entityId: row.entityId,
    storeId: row.storeId,
  };
  let result = await timers.arm(tx, input);
  if (result.status === "dispatched") {
    const cancelled = await timers.cancel(tx, {
      subject: input.subject,
      kinds: [input.kind],
      keyPrefix: input.key,
    });
    if (!cancelled.includes(result.id)) throw new AppError("PRECONDITION_CHANGED");
    result = await timers.arm(tx, input);
  }
  if (result.status !== "scheduled") throw new AppError("PRECONDITION_CHANGED");
}

export async function createInvitation(
  deps: InvitationUseCaseDeps,
  ctx: IdentityContext,
  input: InvitationCreateBody,
  options: InvitationOptions = {},
) {
  const ports = configured(deps);
  if (options.idem && options.idem.mode !== "natural")
    throw new TypeError("创建邀请只允许自然请求绑定");
  const parsed = InvitationCreateBodySchema.safeParse(input);
  if (!parsed.success)
    throw new AppError("VALIDATION_FAILED", {
      details: {
        fieldErrors: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  const body = parsed.data;
  if (
    options.principal &&
    (ctx.actor.type !== "merchant" || options.principal.merchantUserId !== ctx.actor.id)
  )
    throw new AppError("AUTH_REQUIRED");
  return createThreePhaseRunner(deps).run(
    {
      async claim(tx) {
        const viewer = await invitationViewer(tx, ctx);
        const binding = await invitationBinding(tx, viewer.memberId, body.clientRequestId);
        if (binding && (binding.entityId !== viewer.entityId || binding.storeId !== viewer.storeId))
          throw new AppError("NOT_FOUND");
        return { bound: binding !== null };
      },
      async external(intent) {
        if (intent.bound || !body.remarkName) return;
        if (!options.principal) throw new AppError("AUTH_REQUIRED");
        await ports.checkRemark(options.principal, body.remarkName);
      },
      async settle(tx) {
        const { viewer, rows, binding } = await lockInvitationContext(tx, ctx, {
          clientRequestId: body.clientRequestId,
        });
        const now = deps.clock.now();
        if (binding) {
          const bound = rows.find((row) => row.id === binding.invitationId);
          if (!bound || bound.inviterMemberId !== viewer.memberId)
            throw new AppError("PRECONDITION_CHANGED");
          return invitationCard(
            tx,
            { ...deps, keyring: ports.keyring },
            now,
            viewer,
            bound,
            bound.clientRequestId !== body.clientRequestId,
          );
        }
        const params = await paramsAt(
          tx,
          ["invitation.ttl_hours", "invitation.require_phone"],
          now,
        );
        const candidate = rows
          .filter(
            (row) =>
              row.inviterMemberId === viewer.memberId &&
              row.status === "pending" &&
              row.sharedAt === null &&
              row.expiresAt > now,
          )
          .sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
          )[0];
        const hasPhone = Object.hasOwn(body, "targetPhone");
        if (
          params["invitation.require_phone"] &&
          (hasPhone ? !body.targetPhone : !candidate?.targetPhoneBidx)
        )
          invalidPhone();
        const expiresAt = new Date(now.getTime() + params["invitation.ttl_hours"] * 3_600_000);
        const keyring = ports.keyring();
        let id: string;
        if (candidate) {
          id = candidate.id;
          const fields = {
            ...(Object.hasOwn(body, "remarkName") ? { remarkName: body.remarkName ?? null } : {}),
            ...(hasPhone ? invitationFields(keyring, body.targetPhone) : {}),
          };
          const changed =
            (Object.hasOwn(fields, "remarkName") && fields.remarkName !== candidate.remarkName) ||
            (hasPhone &&
              !(fields.targetPhoneBidx === null && candidate.targetPhoneBidx === null) &&
              (fields.targetPhoneBidx === null ||
                candidate.targetPhoneBidx === null ||
                !Buffer.from(fields.targetPhoneBidx!).equals(
                  Buffer.from(candidate.targetPhoneBidx),
                )));
          await tx.invitation.update({
            where: { id },
            data: { ...fields, expiresAt, updatedAt: now },
          });
          if (changed)
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
                action: "tenant.invitation.reuse",
                summary: "修改未分享的邀请卡片",
                target: { type: "invitation", id },
                entityId: viewer.entityId,
                storeId: viewer.storeId,
                meta: {
                  changedFields: [
                    ...(Object.hasOwn(body, "remarkName") ? ["remarkName"] : []),
                    ...(hasPhone ? ["targetPhone"] : []),
                  ],
                },
              },
            );
        } else {
          await newInvitationAllowed(tx, deps, now, viewer.entityId);
          id = uuidv7();
          await tx.invitation.create({
            data: {
              id,
              entityId: viewer.entityId,
              storeId: viewer.storeId,
              inviterMemberId: viewer.memberId,
              role: "clerk",
              status: "pending",
              clientRequestId: body.clientRequestId,
              ...newInvitationToken(keyring),
              ...invitationFields(keyring, body.targetPhone),
              remarkName: body.remarkName ?? null,
              expiresAt,
              createdAt: now,
              updatedAt: now,
            },
          });
        }
        await tx.invitationRequest.create({
          data: {
            id: uuidv7(),
            inviterMemberId: viewer.memberId,
            clientRequestId: body.clientRequestId,
            invitationId: id,
            entityId: viewer.entityId,
            storeId: viewer.storeId,
            createdAt: now,
          },
        });
        if (!candidate) {
          if (prepared.has(tx)) throw new TypeError("邀请迁移不能重入");
          prepared.set(tx, {
            ctx,
            id,
            memberId: viewer.memberId,
            event: "invitation.create",
            deps,
          });
          try {
            await deps.flow.transition(tx, ctx, {
              machine: "invitation",
              stateField: "status",
              id,
              event: "invitation.create",
              created: true,
              entityId: viewer.entityId,
              storeId: viewer.storeId,
              audit: {
                stream: "activity",
                category: "member",
                action: "tenant.invitation.create",
                summary: "创建店员邀请",
                target: { type: "invitation", id },
                entityId: viewer.entityId,
                storeId: viewer.storeId,
              },
              emit: {
                type: "invitation.created",
                payload: {
                  v: 1,
                  invitationId: id,
                  entityId: viewer.entityId,
                  storeId: viewer.storeId,
                  expiresAt: expiresAt.toISOString(),
                },
              },
            });
          } finally {
            prepared.delete(tx);
          }
        }
        await scheduleInvitation(tx, ports.timers, {
          id,
          entityId: viewer.entityId,
          storeId: viewer.storeId,
          expiresAt,
        });
        const [row] = await invitationRows(tx, [id]);
        if (!row) throw new AppError("INTERNAL");
        return invitationCard(
          tx,
          { ...deps, keyring: ports.keyring },
          now,
          viewer,
          row,
          !!candidate,
        );
      },
    },
    options,
  );
}

export async function markInvitationSharedIn(
  tx: Tx,
  deps: InvitationUseCaseDeps,
  ctx: IdentityContext,
  invitationId: string,
) {
  configured(deps);
  const { rows } = await lockInvitationContext(tx, ctx, { invitationId });
  const row = rows.find((value) => value.id === invitationId);
  if (!row) throw new AppError("NOT_FOUND");
  const sharedAt =
    row.status === "pending" && row.sharedAt === null ? deps.clock.now() : row.sharedAt;
  if (sharedAt !== row.sharedAt)
    await tx.invitation.update({ where: { id: row.id }, data: { sharedAt, updatedAt: sharedAt! } });
  return { invitationId: row.id, sharedAt: sharedAt?.toISOString() ?? null };
}

export async function revokeInvitationIn(
  tx: Tx,
  deps: InvitationUseCaseDeps,
  ctx: IdentityContext,
  input: InvitationRevokeBody & { invitationId: string },
): Promise<InvitationRevokeResult> {
  const ports = configured(deps);
  const { viewer, rows } = await lockInvitationContext(tx, ctx, input);
  const row = rows.find((value) => value.id === input.invitationId);
  if (!row) throw new AppError("NOT_FOUND");
  if (row.status !== "pending" || (input.reason === "unshared_leave" && row.sharedAt !== null))
    throw new AppError("STATE_NOT_ALLOWED");
  if (!["by_owner", "unshared_leave"].includes(input.reason))
    throw new AppError("VALIDATION_FAILED");
  const now = deps.clock.now();
  if (prepared.has(tx)) throw new TypeError("邀请迁移不能重入");
  prepared.set(tx, {
    ctx,
    id: row.id,
    memberId: viewer.memberId,
    event: "invitation.revoke",
    deps,
  });
  try {
    await deps.flow.transition(tx, ctx, {
      machine: "invitation",
      stateField: "status",
      id: row.id,
      entityId: viewer.entityId,
      storeId: viewer.storeId,
      event: "invitation.revoke",
      reasonCode: input.reason,
      set: {
        revoked_at: now,
        revoke_actor_type: "merchant",
        revoke_actor_id: ctx.actor.id,
        revoke_client: "weapp",
        revoke_reason: input.reason,
        token_enc: null,
      },
      audit: {
        stream: "activity",
        category: "member",
        action: "tenant.invitation.revoke",
        summary: "撤回店员邀请",
        target: { type: "invitation", id: row.id },
        entityId: viewer.entityId,
        storeId: viewer.storeId,
        reason: { code: input.reason },
      },
      emit: {
        type: "invitation.revoked",
        payload: { v: 1, invitationId: row.id, entityId: viewer.entityId, storeId: viewer.storeId },
      },
    });
    await ports.timers.cancel(tx, {
      subject: { type: "invitation", id: row.id },
      kinds: ["invitation.expire"],
    });
    return { invitationId: row.id, status: "revoked", revokedAt: now.toISOString() };
  } finally {
    prepared.delete(tx);
  }
}
