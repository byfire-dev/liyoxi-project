import { assertAccess } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { lockTickets, ticketOf } from "./repo.js";
import { unpaused, dramaUsesAi } from "./quality.js";

/** L3 owns the task scope, assignment, pauses, and frozen advertising facts. */
export async function authorizeBatchUpload(
  tx: Tx,
  staff: StaffContext,
  orderItemId: string,
  options: { lock?: boolean; readOnly?: boolean } = {},
) {
  assertAccess(staff, {
    module: { module: "delivery", need: options.readOnly ? "view" : "edit" },
    permission: "delivery.episode.register",
  });
  const found = await tx.deliveryTicket.findUnique({
    where: { orderItemId },
    select: { id: true },
  });
  if (!found) throw new AppError("NOT_FOUND");
  const scopedStaff =
    staff.moduleLevels.delivery === "o"
      ? { ...staff, moduleLevels: { ...staff.moduleLevels, delivery: "v" as const } }
      : staff;
  const t = await ticketOf(tx, found.id, scopedStaff);
  if (!options.readOnly) {
    if (options.lock) await lockTickets(tx, [t.id]);
    const current = options.lock ? await ticketOf(tx, t.id, scopedStaff) : t;
    unpaused(current);
    if (
      current.editorId &&
      current.editorId !== staff.staff.id &&
      !staff.staff.isLead &&
      staff.staff.roleKey !== "super_admin"
    )
      throw new AppError("PERMISSION_DENIED");
    // Reissue registration is still owned by W3-06; the current real consumer rejects it too.
    if (!["batch_compose", "delivering"].includes(current.step) || current.deliveredAt)
      throw new AppError("EPISODE_REGISTER_NOT_ALLOWED", {
        details: { step: current.step, reason: "step" },
      });
  }
  return readBatchUploadFacts(tx, orderItemId);
}

export async function readBatchUploadFacts(tx: Tx, orderItemId: string) {
  const row = await tx.deliveryTicket.findUnique({ where: { orderItemId }, select: { id: true } });
  if (!row) throw new AppError("NOT_FOUND");
  const t = await ticketOf(tx, row.id);
  const placements = await tx.orderItemPlacement.findMany({
    where: { orderItemId },
    include: { ad: true },
  });
  const version = async (slot: string): Promise<string | null> => {
    const p = placements.find((row) => row.slot === slot);
    if (!p) return null;
    const v = await tx.adVersion.findFirst({
      where: {
        adId: p.adId,
        ...(p.boundVersionNo !== null
          ? { versionNo: p.boundVersionNo }
          : { decision: "confirmed" }),
      },
      orderBy: { versionNo: "desc" },
      select: { id: true, entityId: true, storeId: true },
    });
    if (!v || v.entityId !== t.entityId || v.storeId !== t.storeId)
      throw new AppError("PRECONDITION_CHANGED");
    return v.id;
  };
  return {
    expectedCount: t.orderItem.episodeCount,
    entityId: t.entityId,
    storeId: t.storeId,
    dramaId: t.dramaId,
    targetLabel: `《${(t.orderItem.dramaSnapshot as { title: string }).title}》· ${t.ticketNo}`,
    forcedByDrama: await dramaUsesAi(tx, t.dramaId),
    productionContext: {
      headAdVersionId: await version("opening"),
      tailAdVersionId: await version("ending"),
      productionTier: t.orderItem.productionModel,
    },
  };
}
