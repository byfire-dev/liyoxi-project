import {
  authorize,
  buildStaffContext,
  isStaffRoleKey,
  normalizeRoleConfig,
  storeScope,
} from "../authz/index.js";
import { record } from "../audit/index.js";
import { createIdentityContext, staffFollowUpPort, uuidv7 } from "../kernel/index.js";
import type { Assembly, Tx } from "../kernel/index.js";

/** Caller locks the current staff/parent graph first. No new follow-up subject or permission is introduced. */
export async function createLicenseFollowUp(
  tx: Tx,
  assembly: Assembly,
  input: {
    orderItemId: string;
    ownerStaffId: string;
    revisionId: string;
    licenseEndDate: string;
    now: Date;
  },
) {
  const reader = assembly.portEntries(staffFollowUpPort).get("order_item"),
    fact = reader ? await reader(tx, input.orderItemId) : null,
    owner = await tx.staff.findUnique({
      where: { id: input.ownerStaffId },
      include: { staffRole: true },
    });
  if (!fact?.storeId || !owner || owner.status !== "active" || !isStaffRoleKey(owner.staffRoleKey))
    return "unavailable" as const;
  const group = owner.staffGroupId
    ? await tx.staff.findMany({
        where: { staffGroupId: owner.staffGroupId, status: "active" },
        select: { id: true },
      })
    : [];
  const staff = buildStaffContext({
    staff: {
      id: owner.id,
      roleKey: owner.staffRoleKey,
      isLead: owner.isLead,
      staffGroupId: owner.staffGroupId,
    },
    role: normalizeRoleConfig(owner.staffRoleKey, owner.staffRole),
    groupStaffIds: group.map((r) => r.id),
    stepUpAt: null,
  });
  // Both the mine list and order-item detail/completion must remain usable under the current role.
  try {
    for (const module of ["merchant", "publish"] as const)
      authorize(staff, { module: { module, need: "view" }, permission: null }, input.now);
  } catch {
    return "unavailable" as const;
  }
  if (
    !(await tx.store.findFirst({
      where: { id: fact.storeId, entityId: fact.entityId, ...storeScope(staff.scope) },
      select: { id: true },
    }))
  )
    return "unavailable" as const;
  const content = `版权止日缩短至${input.licenseEndDate}，请复核本订单项并人工处理`;
  if (
    await tx.auditLog.findFirst({
      where: {
        stream: "activity",
        action: "staff.follow_up.license_shortened",
        targetType: "order_item",
        targetId: input.orderItemId,
        AND: [
          { after: { path: ["revisionId"], equals: input.revisionId } },
          { after: { path: ["ownerStaffId"], equals: owner.id } },
        ],
      },
    })
  )
    return "existing" as const;
  const id = uuidv7();
  await tx.followUp.create({
    data: {
      id,
      subjectType: "order_item",
      subjectId: input.orderItemId,
      entityId: fact.entityId,
      storeId: fact.storeId,
      channel: "system",
      content,
      nextFollowAt: input.now,
      ownerStaffId: owner.id,
      actorType: "system",
      createdAt: input.now,
      updatedAt: input.now,
    },
  });
  const ctx = createIdentityContext({ actor: { type: "system", job: "order.license_shortened" } });
  await record(
    tx,
    ctx.actor,
    {
      requestId: ctx.requestId,
      ip: null,
      userAgent: null,
      authMethod: null,
      sessionId: null,
      jobName: "order.license_shortened",
    },
    {
      stream: "activity",
      category: "follow_up",
      action: "staff.follow_up.license_shortened",
      summary: "版权止日缩短，生成人工复核待办",
      target: { type: "order_item", id: input.orderItemId },
      entityId: fact.entityId,
      storeId: fact.storeId,
      before: null,
      after: { revisionId: input.revisionId, ownerStaffId: owner.id, followUpId: id },
      fields: ["revisionId", "ownerStaffId", "followUpId"],
    },
  );
  return "created" as const;
}
