import { AppError, staffFollowUpPort, uuidv7 } from "../kernel/index.js";
import type { Assembly, Tx } from "../kernel/index.js";

/** The delivery parent owns the reissue; staff owns the system follow-up row. */
export async function createReissueFollowUp(
  tx: Tx,
  assembly: Assembly,
  input: {
    reissueId: string;
    ownerStaffId: string;
    now: Date;
  },
) {
  const reader = assembly.portEntries(staffFollowUpPort).get("delivery_reissue");
  const fact = reader ? await reader(tx, input.reissueId) : null;
  if (!fact?.storeId || !fact.entityId) throw new AppError("NOT_FOUND");
  const owner = await tx.staff.findUnique({ where: { id: input.ownerStaffId } });
  if (!owner || owner.status !== "active" || owner.staffRoleKey !== "delivery_manager")
    throw new AppError("ASSIGNEE_INVALID");
  if (
    await tx.followUp.findFirst({
      where: { subjectType: "delivery_reissue", subjectId: input.reissueId, channel: "system" },
    })
  )
    return;
  await tx.followUp.create({
    data: {
      id: uuidv7(),
      subjectType: "delivery_reissue",
      subjectId: input.reissueId,
      entityId: fact.entityId,
      storeId: fact.storeId,
      channel: "system",
      content: "补发后确认商家已替换",
      nextFollowAt: input.now,
      ownerStaffId: input.ownerStaffId,
      actorType: "system",
      createdAt: input.now,
      updatedAt: input.now,
    },
  });
}
