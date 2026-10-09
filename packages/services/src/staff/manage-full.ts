import type {
  ActivationDeliveryBody,
  ActivationIssue,
  StaffResetBody,
  StaffUpdateBody,
  StaffDisableBody,
  HandoverBody,
  StaffUnlockBody,
  StaffWecomBindBody,
  StaffDetail,
  StaffMutationResult,
  HandoverResult,
} from "@liyoxi/contract";
import type { Staff, Prisma } from "@liyoxi/db";
import { assertAccess, assertConfirm } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, isUniqueViolation, lockRows } from "../kernel/index.js";
import { issueStaffDisablePass, issueStaffEnablePass } from "./guards.js";
import type { IdentityContext, Tx, TxRunOptions } from "../kernel/index.js";
import { openField } from "../security/index.js";
import type { StaffManagementDeps } from "./management-deps.js";
import { locked, lockStaffSet, staffAudit } from "./management-shared.js";
import { issueActivationCode } from "./activation.js";
import type { IssuedActivation } from "./activation.js";
import { hasActiveSuperAdmin } from "./repo.js";
import { revokeStaffSessions } from "./session.js";
import { staffBriefOf } from "./me.js";
import { openWork, transferWork, workSources } from "./work.js";

type DetailReader = (tx: Tx, ctx: StaffContext, id: string) => Promise<StaffDetail>;
const active = (row: Staff) => {
  if (row.status !== "active") throw new AppError("STATE_NOT_ALLOWED");
};
const selfForbidden = (ctx: StaffContext, id: string) => {
  if (ctx.staff.id === id) throw new AppError("SELF_OPERATION_FORBIDDEN");
};
async function lastSuper(tx: Tx, row: Staff) {
  if (
    row.staffRoleKey === "super_admin" &&
    row.status === "active" &&
    !(await hasActiveSuperAdmin(tx, row.id))
  )
    throw new AppError("LAST_SUPER_ADMIN");
}
export function createFullStaffManagement(deps: StaffManagementDeps, detail: DetailReader) {
  const access = (
    ctx: StaffContext,
    permission: "sys.staff.manage" | "sys.staff.secure_ops" | "sys.staff.wecom_bind",
  ) => assertAccess(ctx, { module: null, permission });
  async function activationMutation(
    ctx: StaffContext,
    actor: IdentityContext,
    id: string,
    input: ActivationDeliveryBody | StaffResetBody,
    op: "enable" | "resetPassword" | "resetMfa" | "reissue",
    options: TxRunOptions,
  ) {
    access(
      ctx,
      op === "resetPassword" || op === "resetMfa" ? "sys.staff.secure_ops" : "sys.staff.manage",
    );
    if (op === "resetPassword" || op === "resetMfa") selfForbidden(ctx, id);
    let transient:
      { row: Staff; issued: IssuedActivation; purpose: "activate" | "reset_password" } | undefined;
    const result = await deps.tx.run(async (tx) => {
      const row = await locked(tx, id);
      const now = deps.clock.now();
      if ("confirm" in input) assertConfirm(input.confirm, { staffNo: row.staffNo });
      if (op === "enable") {
        if (row.status !== "pending" && row.status !== "disabled")
          throw new AppError("STATE_NOT_ALLOWED");
        if (
          row.staffRoleKey === "channel_ops" &&
          (await deps.config.flags.value("release.partner", { platform: "admin" })) !== true
        )
          throw new AppError("STATE_NOT_ALLOWED", {
            details: {
              reason: "role_not_available",
              roleKey: row.staffRoleKey,
              availableFrom: "v1.1",
            },
          });
        await deps.flow.transition(tx, actor, {
          machine: "staff",
          stateField: "status",
          id,
          event: "staff.enable",
          set: {
            disabled_at: null,
            disabled_reason: null,
            disabled_by_staff_id: null,
            handover_to_staff_id: null,
          },
          audit: {
            stream: "ops",
            category: "staff_authz",
            action: "sys.staff.enable",
            summary: `启用员工 ${row.name}`,
            target: { type: "staff", id },
          },
          emit: { type: "staff.enabled", payload: { v: 1, staffId: id } },
          args: issueStaffEnablePass(tx, id),
        });
      } else active(row);
      if (op === "reissue" && row.passwordHash !== null) throw new AppError("STATE_NOT_ALLOWED");
      const previous = await tx.staffActivation.findFirst({
        where: { staffId: id, usedAt: null, revokedAt: null },
        orderBy: { createdAt: "desc" },
      });
      const purpose: "activate" | "reset_password" =
        op === "resetPassword"
          ? "reset_password"
          : op === "reissue" && previous?.purpose === "reset_password"
            ? "reset_password"
            : "activate";
      const data: Prisma.StaffUpdateInput = { updatedAt: now };
      if (op !== "reissue") data.passwordHash = null;
      if (op === "enable")
        Object.assign(data, {
          failTrusted: 0,
          failUntrusted: 0,
          lockedUntilTrusted: null,
          lockedUntilUntrusted: null,
        });
      if (op === "resetMfa")
        Object.assign(data, {
          totpSecretEnc: null,
          totpEnrolledAt: null,
          totpPendingSecretEnc: null,
          totpPendingAt: null,
          totpLastStep: null,
          recoveryCodes: [],
        });
      await tx.staff.update({ where: { id }, data });
      if (op === "resetPassword" || op === "resetMfa")
        await revokeStaffSessions(tx, {
          staffId: id,
          reason: op === "resetMfa" ? "mfa_reset" : "password_reset",
          now,
        });
      const issued = await issueActivationCode(tx, {
        staffId: id,
        purpose,
        delivery: "manual",
        createdByStaffId: ctx.staff.id,
        now,
      });
      transient = { row, issued, purpose };
      if (op !== "enable")
        await staffAudit(
          tx,
          actor,
          row,
          op === "resetPassword"
            ? "sys.staff.reset_password"
            : op === "resetMfa"
              ? "sys.staff.reset_mfa"
              : "sys.staff.reissue_activation_code",
          `重新生成员工凭据 ${row.name}`,
        );
      return {
        staff: await detail(tx, ctx, id),
        activation: {
          purpose,
          delivery: "manual" as const,
          expiresAt: issued.expiresAt.toISOString(),
          activationCode: null,
          replayed: false,
        },
        replayed: false,
      };
    }, options);
    if (result.replayed || !transient)
      return {
        ...result,
        activation: { ...result.activation, activationCode: null, replayed: result.replayed },
      };
    const issued = transient;
    let sent = false;
    if (input.activationDelivery === "sms" && deps.sendActivation) {
      const phone = openField(deps.keyring(), "staff.phone_enc", issued.row.phoneEnc);
      try {
        sent =
          (
            await deps.sendActivation({
              phone,
              code: issued.issued.code,
              activationId: issued.issued.id,
            })
          ).status === "sent";
      } catch {
        sent = false;
      }
    }
    if (sent)
      await deps.tx.run(async (tx) => {
        await tx.staffActivation.updateMany({
          where: { id: issued.issued.id, usedAt: null, revokedAt: null },
          data: { delivery: "sms", updatedAt: deps.clock.now() },
        });
      });
    return {
      ...result,
      activation: {
        ...result.activation,
        delivery: sent ? ("sms" as const) : ("manual" as const),
        activationCode: sent ? null : issued.issued.code,
      },
    };
  }
  return {
    async update(
      ctx: StaffContext,
      actor: IdentityContext,
      id: string,
      input: StaffUpdateBody,
      options: TxRunOptions = {},
    ): Promise<StaffDetail> {
      access(ctx, "sys.staff.manage");
      return deps.tx.run(async (tx) => {
        const supers = await tx.staff.findMany({
          where: { status: "active", staffRoleKey: "super_admin" },
          select: { id: true },
        });
        await lockStaffSet(tx, [id, ...supers.map((r) => r.id)]);
        const row = await tx.staff.findUniqueOrThrow({ where: { id } });
        const now = deps.clock.now();
        if (row.lockVersion !== input.lockVersion)
          throw new AppError("VERSION_CONFLICT", { details: { currentVersion: row.lockVersion } });
        const changingRole = input.roleKey !== undefined && input.roleKey !== row.staffRoleKey;
        if (changingRole) {
          selfForbidden(ctx, id);
          await lastSuper(tx, row);
          const items = await workSources(deps).read(tx, { staffId: id, now });
          if (items.length)
            throw new AppError("OPEN_WORK_EXISTS", {
              details: { openWork: (await openWork(tx, deps, row)).bySource },
            });
        }
        const roleKey = input.roleKey ?? row.staffRoleKey;
        const group = input.staffGroupId
          ? await tx.staffGroup.findUnique({ where: { id: input.staffGroupId } })
          : changingRole
            ? await tx.staffGroup.findFirst({ where: { staffRoleKey: roleKey, isDefault: true } })
            : row.staffGroupId
              ? await tx.staffGroup.findUnique({ where: { id: row.staffGroupId } })
              : null;
        if (!group || group.staffRoleKey !== roleKey)
          throw new AppError("VALIDATION_FAILED", { message: "分组不属于该角色" });
        if (
          row.isLead &&
          row.status === "active" &&
          (!(input.isLead ?? row.isLead) || group.id !== row.staffGroupId)
        ) {
          const others = await tx.staff.count({
            where: {
              staffGroupId: row.staffGroupId,
              id: { not: id },
              status: "active",
              isLead: true,
            },
          });
          if (!others && !input.ackNoLead) throw new AppError("LEAD_REMOVAL_ACK_REQUIRED");
        }
        if (input.wecomQrFileId !== undefined && input.wecomQrFileId !== row.wecomQrFileId) {
          if (!deps.media)
            throw new AppError("INTERNAL", { message: "员工二维码文件引用尚未装配" });
          await lockRows(
            tx,
            "file_object",
            [input.wecomQrFileId, row.wecomQrFileId].filter((id): id is string => id !== null),
          );
          if (input.wecomQrFileId)
            await deps.media.link(tx, {
              fileId: input.wecomQrFileId,
              refType: "staff",
              refId: id,
              role: "wecom_qr",
              entityId: null,
              storeId: null,
            });
          if (row.wecomQrFileId)
            await deps.media.release(tx, {
              fileId: row.wecomQrFileId,
              refType: "staff",
              refId: id,
              role: "wecom_qr",
              entityId: null,
              storeId: null,
              keepUntil: new Date(now.getTime() + 7 * 86400000),
            });
        }
        const after = await tx.staff.update({
          where: { id },
          data: {
            name: input.name,
            staffRoleKey: roleKey,
            staffGroupId: group.id,
            isLead: input.isLead,
            displayName: input.displayName,
            servicePhone: input.servicePhone,
            wecomQrFileId: input.wecomQrFileId,
            ...(changingRole && row.status === "disabled" ? { handoverToStaffId: null } : {}),
            lockVersion: { increment: 1 },
            updatedAt: now,
          },
        });
        if (changingRole) await tx.assignmentPoolMember.deleteMany({ where: { staffId: id } });
        await staffAudit(
          tx,
          actor,
          row,
          "sys.staff.update",
          `编辑员工 ${row.name}`,
          {
            before: row,
            after,
            fields: [
              "name",
              "staffRoleKey",
              "staffGroupId",
              "isLead",
              "displayName",
              "servicePhone",
              "wecomQrFileId",
            ],
          },
          { ackNoLead: input.ackNoLead },
        );
        return detail(tx, ctx, id);
      }, options);
    },
    enable: (
      ctx: StaffContext,
      actor: IdentityContext,
      id: string,
      input: ActivationDeliveryBody,
      options: TxRunOptions = {},
    ): Promise<StaffMutationResult> => activationMutation(ctx, actor, id, input, "enable", options),
    resetPassword: (
      ctx: StaffContext,
      actor: IdentityContext,
      id: string,
      input: StaffResetBody,
      options: TxRunOptions = {},
    ): Promise<StaffMutationResult> =>
      activationMutation(ctx, actor, id, input, "resetPassword", options),
    resetMfa: (
      ctx: StaffContext,
      actor: IdentityContext,
      id: string,
      input: StaffResetBody,
      options: TxRunOptions = {},
    ): Promise<StaffMutationResult> =>
      activationMutation(ctx, actor, id, input, "resetMfa", options),
    async reissueActivationCode(
      ctx: StaffContext,
      actor: IdentityContext,
      id: string,
      input: ActivationDeliveryBody,
      options: TxRunOptions = {},
    ): Promise<ActivationIssue> {
      return (await activationMutation(ctx, actor, id, input, "reissue", options)).activation!;
    },
    async openWork(ctx: StaffContext, id: string) {
      access(ctx, "sys.staff.manage");
      return deps.tx.run(async (tx) => {
        const row = await tx.staff.findUnique({ where: { id } });
        if (!row) throw new AppError("NOT_FOUND");
        return openWork(tx, deps, row);
      });
    },
    async handover(
      ctx: StaffContext,
      actor: IdentityContext,
      id: string,
      input: HandoverBody,
      options: TxRunOptions = {},
    ): Promise<HandoverResult> {
      access(ctx, "sys.staff.manage");
      return deps.tx.run(async (tx) => {
        const rows = await lockStaffSet(tx, [id, input.handoverToStaffId]);
        const from = rows.get(id)!,
          to = rows.get(input.handoverToStaffId)!;
        active(from);
        assertRecipient(from, to);
        const batch = await transferWork(tx, deps, actor, {
          from,
          to,
          reason: input.reason,
          note: input.note,
        });
        await staffAudit(
          tx,
          actor,
          from,
          "sys.staff.handover",
          `移交员工 ${from.name} 的在办事项`,
          undefined,
          { impact: batch.moved, batchId: batch.batchId },
        );
        return { staff: await detail(tx, ctx, id), ...batch, handoverTo: staffBriefOf(to) };
      }, options);
    },
    async disable(
      ctx: StaffContext,
      actor: IdentityContext,
      id: string,
      input: StaffDisableBody,
      options: TxRunOptions = {},
    ): Promise<HandoverResult> {
      access(ctx, "sys.staff.secure_ops");
      if (ctx.staff.id === id) throw new AppError("CANNOT_DISABLE_SELF");
      return deps.tx.run(async (tx) => {
        const supers = await tx.staff.findMany({
          where: { status: "active", staffRoleKey: "super_admin" },
          select: { id: true },
        });
        const rows = await lockStaffSet(tx, [
          id,
          ...(input.handoverToStaffId ? [input.handoverToStaffId] : []),
          ...supers.map((r) => r.id),
        ]);
        const from = rows.get(id)!;
        active(from);
        await lastSuper(tx, from);
        const items = await workSources(deps).read(tx, { staffId: id, now: deps.clock.now() });
        assertConfirm(input.confirm, { staffNo: from.staffNo, openWorkCount: items.length });
        const to = input.handoverToStaffId ? rows.get(input.handoverToStaffId)! : null;
        if (to) assertRecipient(from, to);
        if (items.length && !to) {
          const candidate = await tx.staff.findFirst({
            where: { id: { not: id }, status: "active", staffRoleKey: from.staffRoleKey },
          });
          if (!candidate) throw new AppError("NO_HANDOVER_CANDIDATE");
          throw new AppError("VALIDATION_FAILED", { message: "有在办事项时必须选择移交接收人" });
        }
        const batch = to
          ? await transferWork(tx, deps, actor, {
              from,
              to,
              reason: input.reason,
              note: input.note,
              confirm: input.confirm,
            })
          : { batchId: null, moved: [] };
        const now = deps.clock.now();
        await tx.staff.update({
          where: { id },
          data: { wecomBindStatus: "unbound", updatedAt: now },
        });
        await deps.flow.transition(tx, actor, {
          machine: "staff",
          stateField: "status",
          id,
          event: "staff.disable",
          reasonCode: input.reason,
          note: input.note,
          set: {
            disabled_at: now,
            disabled_reason: input.reason,
            disabled_by_staff_id: ctx.staff.id,
            handover_to_staff_id: to?.id ?? null,
          },
          audit: {
            stream: "ops",
            category: "staff_authz",
            action: "sys.staff.disable",
            summary: `禁用员工 ${from.name}`,
            target: { type: "staff", id },
            meta: { impact: batch.moved, batchId: batch.batchId ?? undefined },
          },
          emit: {
            type: "staff.disabled",
            payload: { v: 1, staffId: id, handoverBatchId: batch.batchId ?? undefined },
          },
          args: issueStaffDisablePass(tx, id),
        });
        await revokeStaffSessions(tx, { staffId: id, reason: "disabled", now });
        await tx.assignmentPoolMember.deleteMany({ where: { staffId: id } });
        await tx.staffActivation.updateMany({
          where: { staffId: id, usedAt: null, revokedAt: null },
          data: { revokedAt: now, updatedAt: now },
        });
        return {
          staff: await detail(tx, ctx, id),
          ...batch,
          handoverTo: to ? staffBriefOf(to) : null,
        };
      }, options);
    },
    async unlock(
      ctx: StaffContext,
      actor: IdentityContext,
      id: string,
      input: StaffUnlockBody,
      options: TxRunOptions = {},
    ) {
      access(ctx, "sys.staff.manage");
      return deps.tx.run(async (tx) => {
        const row = await locked(tx, id);
        const now = deps.clock.now();
        await tx.staff.update({
          where: { id },
          data: {
            ...(input.bucket !== "untrusted" ? { failTrusted: 0, lockedUntilTrusted: null } : {}),
            ...(input.bucket !== "trusted" ? { failUntrusted: 0, lockedUntilUntrusted: null } : {}),
            updatedAt: now,
          },
        });
        await staffAudit(
          tx,
          actor,
          row,
          "sys.staff.unlock",
          `解除员工登录锁定 ${row.name}`,
          undefined,
          { bucket: input.bucket },
        );
        return detail(tx, ctx, id);
      }, options);
    },
    async inviteWecom(
      ctx: StaffContext,
      actor: IdentityContext,
      id: string,
      options: TxRunOptions = {},
    ) {
      access(ctx, "sys.staff.wecom_bind");
      let invitationCreatedAt: Date | undefined;
      const result = await deps.tx.run(async (tx) => {
        const row = await locked(tx, id);
        active(row);
        if (row.wecomBindStatus === "bound") throw new AppError("STATE_NOT_ALLOWED");
        const now = deps.clock.now();
        const after = await tx.staff.update({
          where: { id },
          data: { wecomBindStatus: "invited", updatedAt: now },
        });
        invitationCreatedAt = row.createdAt;
        await staffAudit(
          tx,
          actor,
          row,
          "sys.staff.wecom_invite",
          `邀请员工绑定企业微信 ${row.name}`,
        );
        return {
          replayed: false,
          status: after.wecomBindStatus,
          userid: after.wecomUserid,
          boundAt: after.wecomBoundAt?.toISOString() ?? null,
          qrFileId: after.wecomQrFileId,
          qrUrl: null,
        };
      }, options);
      if (!result.replayed && invitationCreatedAt && deps.sendWecomInvite) {
        // Business state is already committed. A later retry can deliver the still-invited staff inbox.
        try {
          await deps.sendWecomInvite({ staffId: id, createdAt: invitationCreatedAt });
        } catch {
          /* Remains invited; no external delivery is claimed. */
        }
      }
      return result;
    },
    async bindWecom(
      ctx: StaffContext,
      actor: IdentityContext,
      id: string,
      input: StaffWecomBindBody,
      options: TxRunOptions = {},
    ) {
      access(ctx, "sys.staff.wecom_bind");
      try {
        return await deps.tx.run(async (tx) => {
          const prior = await tx.staff.findUnique({ where: { wecomUserid: input.wecomUserid } });
          const rows = await lockStaffSet(tx, [id, ...(prior ? [prior.id] : [])]);
          const row = rows.get(id)!;
          if (row.status === "disabled") throw new AppError("STATE_NOT_ALLOWED");
          const occupied = await tx.staff.findUnique({ where: { wecomUserid: input.wecomUserid } });
          if (occupied && occupied.id !== id) {
            if (!input.takeOver)
              throw new AppError("WECOM_USERID_TAKEN", {
                details: { staffId: occupied.id, name: occupied.name, status: occupied.status },
              });
            if (occupied.id !== prior?.id) throw new AppError("BUSY");
            await tx.staff.update({
              where: { id: occupied.id },
              data: { wecomUserid: null, wecomBindStatus: "unbound", updatedAt: deps.clock.now() },
            });
          }
          const after = await tx.staff.update({
            where: { id },
            data: {
              wecomUserid: input.wecomUserid,
              wecomBindStatus: "bound",
              wecomBoundAt: deps.clock.now(),
              updatedAt: deps.clock.now(),
            },
          });
          await staffAudit(
            tx,
            actor,
            row,
            "sys.staff.wecom_bind",
            `录入企业微信账号 ${row.name}`,
            undefined,
            { takeOver: input.takeOver, takeOverFromStaffId: occupied?.id ?? null },
          );
          return {
            replayed: false,
            status: after.wecomBindStatus,
            userid: after.wecomUserid,
            boundAt: after.wecomBoundAt!.toISOString(),
            qrFileId: after.wecomQrFileId,
            qrUrl: null,
          };
        }, options);
      } catch (error) {
        if (isUniqueViolation(error, ["uq_staff_wecom_userid"]))
          throw new AppError("WECOM_USERID_TAKEN", { cause: error });
        throw error;
      }
    },
  };
}
function assertRecipient(from: Staff, to: Staff) {
  const reason =
    to.id === from.id
      ? "same_as_current"
      : to.status !== "active"
        ? "not_active"
        : to.staffRoleKey !== from.staffRoleKey
          ? "role_mismatch"
          : null;
  if (reason) throw new AppError("ASSIGNEE_INVALID", { details: { staffId: to.id, reason } });
}
