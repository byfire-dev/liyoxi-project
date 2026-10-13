import {
  MerchantUserForceLogoutBodySchema,
  MerchantUserIdParamsSchema,
  MerchantUserStatusBodySchema,
} from "@liyoxi/contract";
import type {
  MerchantUserForceLogoutBody,
  MerchantUserStatusBody,
  MerchantUserStatusView,
} from "@liyoxi/contract";
import { record } from "../audit/index.js";
import type { AuditRequestMeta } from "../audit/index.js";
import { assertConfirm, authorize, entityScope } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import type { Flow, Guard } from "../flow/index.js";
import { currentIdentityStaff } from "./staff-auth.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Clock, IdempotencyContext, IdentityContext, Tx, TxRunner } from "../kernel/index.js";

export type AdminUserAction = "disable" | "enable" | "forceLogout";
export type AdminUserActionInput = { merchantUserId: string } & (
  MerchantUserStatusBody | MerchantUserForceLogoutBody
);
export interface AdminUserActionOptions {
  idem: IdempotencyContext;
  meta: AuditRequestMeta;
}
interface Deps {
  tx: TxRunner;
  clock: Clock;
  flow: Pick<Flow, "transition">;
}
type Member = { id: string; entityId: string; role: string };
type Prepared = {
  deps: Deps;
  ctx: IdentityContext;
  staff: StaffContext;
  op: AdminUserAction;
  input: AdminUserActionInput;
  meta: AuditRequestMeta;
  members: Member[];
};
const prepared = new WeakMap<Tx, Prepared>();
const permission = (op: AdminUserAction) =>
  op === "forceLogout" ? "merchant.user.force_logout" : "merchant.user.disable";

async function currentStaff(tx: Tx, state: Omit<Prepared, "members">): Promise<StaffContext> {
  const fresh = await currentIdentityStaff(
    tx,
    state.deps.clock,
    state.ctx,
    state.staff,
    state.meta,
  );
  authorize(
    fresh,
    { module: { module: "merchant", need: "view" }, permission: permission(state.op) },
    state.deps.clock.now(),
  );
  return fresh;
}
const membersOf = (tx: Tx, id: string) =>
  tx.entityMember.findMany({
    where: { merchantUserId: id, status: "active" },
    select: { id: true, entityId: true, role: true },
    orderBy: { id: "asc" },
  });
async function visibleTarget(
  tx: Tx,
  merchantUserId: string,
  staff: StaffContext,
  members?: Member[],
) {
  members ??= await membersOf(tx, merchantUserId);
  const entityIds = [...new Set(members.map((member) => member.entityId))];
  if (
    entityIds.length
      ? (await tx.entity.count({
          where: { AND: [{ id: { in: entityIds } }, entityScope(staff.scope)] },
        })) !== entityIds.length
      : staff.scope.kind !== "all"
  )
    throw new AppError("NOT_FOUND");
  const account = await tx.merchantUser.findUnique({ where: { id: merchantUserId } });
  if (!account) throw new AppError("NOT_FOUND");
  return account;
}
async function check(tx: Tx, state: Prepared) {
  const staff = await currentStaff(tx, state),
    members = await membersOf(tx, state.input.merchantUserId);
  if (JSON.stringify(members) !== JSON.stringify(state.members)) throw new AppError("BUSY");
  const account = await visibleTarget(tx, state.input.merchantUserId, staff, members);
  if (
    (state.op === "disable" && account.status !== "active") ||
    (state.op === "enable" && account.status !== "disabled") ||
    (state.op === "forceLogout" && account.status === "deleted")
  )
    throw new AppError("STATE_NOT_ALLOWED");
  assertConfirm(state.input.confirm, { phoneMask: account.phoneMask });
  return account;
}
/** 普通args、旧scope和其他调用路径都不能伪造管理迁移的授权。 */
export const guardAdminUserAction: Guard = async (tx, facts) => {
  const state = prepared.get(tx);
  if (
    !state ||
    facts.ctx !== state.ctx ||
    facts.subjectId !== state.input.merchantUserId ||
    facts.event !== `merchant_user.${state.op}` ||
    state.op === "forceLogout"
  )
    return false;
  await check(tx, state);
  return true;
};

export async function adminUserAction(
  deps: Deps,
  ctx: IdentityContext,
  staff: StaffContext,
  op: AdminUserAction,
  input: AdminUserActionInput,
  options: AdminUserActionOptions,
): Promise<MerchantUserStatusView> {
  const params = MerchantUserIdParamsSchema.safeParse({ merchantUserId: input.merchantUserId });
  const { merchantUserId, ...rawBody } = input;
  const body = (
    op === "forceLogout" ? MerchantUserForceLogoutBodySchema : MerchantUserStatusBodySchema
  ).safeParse(rawBody);
  if (!params.success || !body.success) throw new AppError("VALIDATION_FAILED");
  if (options?.idem?.mode !== "required") throw new AppError("INTERNAL");
  const state: Prepared = {
    deps,
    ctx,
    staff,
    op,
    input: { merchantUserId, ...body.data },
    meta: { ...options.meta },
    members: [],
  };
  // 缓存命中也须完成当前身份/权限/再验证；HTTP鉴权仍在原middleware执行。
  await deps.tx.run(async (tx) => {
    const fresh = await currentStaff(tx, state);
    await visibleTarget(tx, merchantUserId, fresh);
  });
  return deps.tx.run(
    async (tx) => {
      await lockRows(tx, "staff", [staff.staff.id], "share");
      await lockRows(tx, "merchant_user", [merchantUserId]);
      const identities = await tx.wechatIdentity.findMany({
        where: { merchantUserId },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      await lockRows(
        tx,
        "wechat_identity",
        identities.map((identity) => identity.id),
      );
      state.members = await membersOf(tx, merchantUserId);
      await lockRows(
        tx,
        "entity",
        [...new Set(state.members.map((member) => member.entityId))].sort(),
      );
      await lockRows(
        tx,
        "entity_member",
        state.members.map((member) => member.id),
      );
      const account = await check(tx, state),
        now = deps.clock.now();
      const action =
        `identity.merchant_user.${op === "forceLogout" ? "force_logout" : op}` as const;
      const summary =
        op === "disable" ? "禁用商家账号" : op === "enable" ? "启用商家账号" : "强制商家账号下线";
      if (op !== "forceLogout") {
        if (prepared.has(tx)) throw new AppError("INTERNAL");
        prepared.set(tx, state);
        try {
          await deps.flow.transition(tx, ctx, {
            machine: "merchant_user",
            stateField: "status",
            id: merchantUserId,
            event: `merchant_user.${op}`,
            ref: op === "disable" ? "02:126" : "02:127",
            note: state.input.reasonText!,
            meta: state.meta,
            audit: {
              stream: "ops",
              category: "account_security",
              action,
              summary,
              target: { type: "merchant_user", id: merchantUserId },
              reason: { code: "other", text: state.input.reasonText! },
            },
            emit: {
              type: op === "disable" ? "merchant_user.disabled" : "merchant_user.enabled",
              payload: { v: 1, merchantUserId },
            },
          });
        } finally {
          prepared.delete(tx);
        }
      }
      let revokedSessionCount = 0,
        revokedPortalSessionCount = 0;
      if (op !== "enable") {
        revokedSessionCount = (
          await tx.userSession.updateMany({
            where: { merchantUserId, revokedAt: null },
            data: { revokedAt: now, revokeReason: "admin", updatedAt: now },
          })
        ).count;
        revokedPortalSessionCount = (
          await tx.portalSession.updateMany({
            where: { approvedByUserId: merchantUserId, revokedAt: null },
            data: { revokedAt: now, revokeReason: "account_action", updatedAt: now },
          })
        ).count;
        if (op === "forceLogout") {
          await tx.wechatIdentity.updateMany({
            where: { merchantUserId },
            data: { silentLoginEnabled: false, updatedAt: now },
          });
          await record(tx, ctx.actor, state.meta, {
            stream: "ops",
            category: "account_security",
            entityId: null,
            action,
            summary,
            target: { type: "merchant_user", id: merchantUserId },
            ...(state.input.reasonText
              ? { reason: { code: "other", text: state.input.reasonText } }
              : {}),
            meta: { revokedSessionCount, revokedPortalSessionCount },
          });
        }
      }
      return {
        merchantUserId,
        status:
          op === "disable"
            ? "disabled"
            : op === "enable"
              ? "active"
              : (account.status as MerchantUserStatusView["status"]),
        phoneMask: account.phoneMask,
        revokedSessionCount,
        revokedPortalSessionCount,
        activeOwnerEntityIds: state.members
          .filter((member) => member.role === "owner")
          .map((member) => member.entityId)
          .sort(),
      };
    },
    { idem: options.idem },
  );
}
