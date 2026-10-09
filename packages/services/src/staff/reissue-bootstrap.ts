import { record } from "../audit/index.js";
import { AppError, createIdentityContext } from "../kernel/index.js";
import type { StaffAuthContext } from "./types.js";
import { issueActivationCode } from "./activation.js";
import { lockStaff } from "./repo.js";

/** Recovery for the still-unactivated bootstrap account, never a general administrator reset. */
export async function reissueBootstrapActivation(
  ctx: StaffAuthContext,
  input: { staffId: string; confirmStaffNo: number },
) {
  return ctx.tx.run(async (tx) => {
    const staff = await lockStaff(tx, input.staffId);
    const now = ctx.clock.now();
    if (
      !staff ||
      staff.status !== "active" ||
      staff.staffRoleKey !== "super_admin" ||
      staff.passwordHash !== null ||
      staff.staffNo !== input.confirmStaffNo
    )
      throw new AppError("STATE_NOT_ALLOWED");
    const bootstrapped = await tx.statusTransition.findFirst({
      where: { machine: "staff", subjectId: staff.id, event: "staff.bootstrap" },
    });
    const count = await tx.staff.count({
      where: { staffRoleKey: "super_admin", status: "active" },
    });
    const previous = await tx.staffActivation.findFirst({
      where: { staffId: staff.id, purpose: "activate", usedAt: null, revokedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (!bootstrapped || count !== 1 || !previous || previous.expiresAt > now)
      throw new AppError("STATE_NOT_ALLOWED");
    const issued = await issueActivationCode(tx, {
      staffId: staff.id,
      purpose: "activate",
      delivery: "manual",
      createdByStaffId: null,
      now,
    });
    const identity = createIdentityContext({
      actor: { type: "system", job: "cli.staff.reissue_activation" },
    });
    await record(
      tx,
      identity.actor,
      {
        requestId: null,
        ip: null,
        userAgent: null,
        authMethod: "system",
        sessionId: null,
        jobName: "cli.staff.reissue_activation",
      },
      {
        stream: "ops",
        category: "account_security",
        action: "sys.staff.reissue_activation_code",
        summary: "补发首位管理员的过期激活码",
        target: { type: "staff", id: staff.id },
        meta: { previousActivationId: previous.id, activationId: issued.id },
      },
    );
    return {
      staffId: staff.id,
      staffNo: staff.staffNo,
      activationCode: issued.code,
      activationExpiresAt: issued.expiresAt,
    };
  });
}
