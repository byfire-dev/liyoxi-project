import { AssignmentContactBodySchema, AssignmentContactViewSchema } from "@liyoxi/contract";
import {
  authorize,
  buildStaffContext,
  isStaffRoleKey,
  normalizeRoleConfig,
  storeScope,
} from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { record } from "../audit/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx, TxRunOptions } from "../kernel/index.js";
import { staffBriefOf } from "./me.js";
import { lockStaffSet } from "./management-shared.js";
import type { StaffManagementDeps } from "./management-deps.js";

/** 联系事实由assignment_history所有者写入；门店只读归属与既有scope，不改变门店业务。 */
export function createAssignmentContacts(deps: StaffManagementDeps) {
  async function access(tx: Tx, previous: StaffContext, id: string, lock: boolean) {
    const candidate = await tx.assignmentHistory.findUnique({ where: { id } });
    if (!candidate) throw new AppError("NOT_FOUND");
    // 与改派/员工禁用、日历与SLA处理器共享staff20→store130→history的锁序。
    if (lock) await lockStaffSet(tx, [previous.staff.id, candidate.toStaffId]);
    const actor = await tx.staff.findUnique({ where: { id: previous.staff.id } });
    if (!actor || actor.status !== "active" || !isStaffRoleKey(actor.staffRoleKey))
      throw new AppError("PERMISSION_DENIED");
    const role = await tx.staffRole.findUniqueOrThrow({ where: { key: actor.staffRoleKey } });
    const group = actor.staffGroupId
      ? await tx.staff.findMany({
          where: { staffGroupId: actor.staffGroupId, status: "active" },
          select: { id: true },
        })
      : [];
    const staff = buildStaffContext({
      staff: {
        id: actor.id,
        roleKey: actor.staffRoleKey,
        isLead: actor.isLead,
        staffGroupId: actor.staffGroupId,
      },
      role: normalizeRoleConfig(actor.staffRoleKey, role),
      groupStaffIds: group.map((s) => s.id),
      stepUpAt: previous.stepUpAt,
    });
    authorize(
      staff,
      { module: { module: "merchant", need: "view" }, permission: null },
      deps.clock.now(),
    );
    const recipient = await tx.staff.findUniqueOrThrow({ where: { id: candidate.toStaffId } });
    // 全范围/超级管理员不代替“接收人本人或同组主管”的业务授权。
    const allowed =
      actor.id === recipient.id ||
      (actor.isLead &&
        actor.staffGroupId !== null &&
        actor.staffGroupId === recipient.staffGroupId);
    if (candidate.source !== "store_manager" || candidate.subjectType !== "store") {
      if (!allowed) throw new AppError("PERMISSION_DENIED");
      throw new AppError("STATE_NOT_ALLOWED");
    }
    if (lock) await lockRows(tx, "store", [candidate.subjectId]);
    const store = await tx.store.findFirst({
      where: { id: candidate.subjectId, ...storeScope(staff.scope) },
      select: { id: true, entityId: true },
    });
    if (!store) throw new AppError("NOT_FOUND");
    if (!allowed) throw new AppError("PERMISSION_DENIED");
    if (lock)
      await tx.$queryRaw`SELECT id FROM assignment_history WHERE id=${id}::uuid FOR NO KEY UPDATE`;
    const row = lock ? await tx.assignmentHistory.findUniqueOrThrow({ where: { id } }) : candidate;
    return { row, actor, recipient, store };
  }
  return {
    async markAssignmentContacted(
      staff: StaffContext,
      identity: IdentityContext,
      id: string,
      raw: unknown,
      options: TxRunOptions = {},
    ) {
      if (
        identity.actor.type !== "staff" ||
        identity.actor.id !== staff.staff.id ||
        identity.entityId ||
        identity.storeId
      )
        throw new AppError("PERMISSION_DENIED");
      const input = AssignmentContactBodySchema.safeParse(raw);
      if (!input.success) throw new AppError("VALIDATION_FAILED");
      // 幂等回执重放也须按此刻范围与主管身份检查，不让旧回执绕过撤权。
      await deps.tx.run((tx) => access(tx, staff, id, false));
      return deps.tx.run(async (tx) => {
        const { row, actor, recipient, store } = await access(tx, staff, id, true);
        if (!row.contactDueAt || row.contactedAt || row.contactVoidedAt)
          throw new AppError("STATE_NOT_ALLOWED");
        if (!deps.timers) throw new TypeError("员工联系时限尚未装配");
        const now = deps.clock.now();
        await tx.assignmentHistory.update({
          where: { id },
          data: {
            contactedAt: now,
            contactedByStaffId: actor.id,
            updatedAt: now,
          },
        });
        await deps.timers.cancel(tx, {
          subject: { type: "assignment_history", id },
          kinds: ["sla.breach"],
        });
        await record(
          tx,
          identity.actor,
          {
            requestId: identity.requestId,
            ip: identity.ip,
            userAgent: identity.userAgent,
            sessionId: null,
            authMethod: null,
          },
          {
            stream: "activity",
            category: "manager_assign",
            action: "staff.assignment.contact",
            summary: "标记已联系商家",
            target: { type: "assignment_history", id },
            entityId: store.entityId,
            storeId: store.id,
            before: { contactedAt: null, contactedByStaffId: null },
            after: { contactedAt: now.toISOString(), contactedByStaffId: actor.id },
            fields: ["contactedAt", "contactedByStaffId"],
            meta: { note: input.data.note ?? null },
          },
        );
        return AssignmentContactViewSchema.parse({
          assignmentHistoryId: id,
          storeId: store.id,
          toStaff: staffBriefOf(recipient),
          contactDueAt: row.contactDueAt.toISOString(),
          contactedAt: now.toISOString(),
          contactedBy: staffBriefOf(actor),
        });
      }, options);
    },
  };
}
