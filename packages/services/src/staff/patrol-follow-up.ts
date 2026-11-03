import { AppError, createIdentityContext, staffFollowUpPort, uuidv7 } from "../kernel/index.js";
import { record } from "../audit/index.js";
import type { Assembly, Tx } from "../kernel/index.js";
/** Caller serializes on the patrol parent; staff remains the sole follow-up writer. */
export async function createPatrolFollowUp(
  tx: Tx,
  assembly: Assembly,
  input: {
    patrolTaskId: string;
    ownerStaffId: string;
    now: Date;
  },
) {
  const reader = assembly.portEntries(staffFollowUpPort).get("patrol_task");
  const fact = reader ? await reader(tx, input.patrolTaskId) : null;
  if (!fact?.storeId || !fact.entityId) throw new AppError("NOT_FOUND");
  const owner = await tx.staff.findUnique({ where: { id: input.ownerStaffId } });
  if (!owner || owner.status !== "active" || owner.staffRoleKey !== "delivery_manager")
    throw new AppError("ASSIGNEE_INVALID");
  const previous = await tx.followUp.findFirst({
    where: {
      subjectType: "patrol_task",
      subjectId: input.patrolTaskId,
      channel: "system",
    },
  });
  if (previous) return previous.id;
  const id = uuidv7();
  await tx.followUp.create({
    data: {
      id,
      subjectType: "patrol_task",
      subjectId: input.patrolTaskId,
      entityId: fact.entityId,
      storeId: fact.storeId,
      channel: "system",
      content: "巡检异常三日未恢复，请跟进商家处理",
      nextFollowAt: input.now,
      ownerStaffId: input.ownerStaffId,
      actorType: "system",
      createdAt: input.now,
      updatedAt: input.now,
    },
  });
  const ctx = createIdentityContext({ actor: { type: "system", job: "patrol.followup" } });
  await record(
    tx,
    ctx.actor,
    {
      requestId: ctx.requestId,
      ip: null,
      userAgent: null,
      sessionId: null,
      authMethod: null,
      jobName: "patrol.followup",
    },
    {
      stream: "activity",
      category: "follow_up",
      action: "staff.follow_up.create",
      summary: "巡检异常三日未恢复，生成系统跟进",
      target: { type: "follow_up", id },
      entityId: fact.entityId,
      storeId: fact.storeId,
      before: null,
      after: {
        subjectType: "patrol_task",
        subjectId: input.patrolTaskId,
        ownerStaffId: input.ownerStaffId,
        nextFollowAt: input.now.toISOString(),
      },
      fields: ["subjectType", "subjectId", "ownerStaffId", "nextFollowAt"],
    },
  );
  return id;
}
