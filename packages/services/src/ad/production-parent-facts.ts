import type { Prisma } from "@liyoxi/db";
import { assertAccess, taskScope } from "../authz/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { MediaActor } from "../media/index.js";

/** The ad owner establishes actual task scope before media receives any file facts. */
export async function requireAdProductionAccess(
  tx: Tx,
  actor: MediaActor,
  adId: string,
  permission?: "production.normalize" | "production.restamp" | "production.recheck",
) {
  const staff = actor.staff;
  if (!staff || actor.identity.actor.type !== "staff" || actor.identity.actor.id !== staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  assertAccess(staff, {
    module: { module: "delivery", need: "view" },
    permission: permission ?? null,
  });
  const where: Prisma.AdWhereInput = {
    id: adId,
    ...taskScope<Prisma.AdWhereInput>(staff.scope, {
      store: (store) => ({ store }),
      assignees: [{ col: "editorId", pool: "ad_editor" }],
    }),
    ...(staff.moduleLevels.delivery === "o" ? { editorId: staff.staff.id } : {}),
  };
  if (permission) {
    if (!(await tx.ad.findFirst({ where, select: { id: true } }))) throw new AppError("NOT_FOUND");
    await lockRows(tx, "ad", [adId], "share");
  }
  if (!(await tx.ad.findFirst({ where, select: { id: true } }))) throw new AppError("NOT_FOUND");
}

/** Delivery supplies the versions selected by its own placements; ad owns their facts. */
export function readMaterialAdVersions(
  tx: Tx,
  pairs: readonly { adId: string; versionNo: number }[],
) {
  return tx.adVersion.findMany({
    where: { OR: pairs.map(({ adId, versionNo }) => ({ adId, versionNo })) },
    select: {
      id: true,
      adId: true,
      entityId: true,
      storeId: true,
      versionNo: true,
      decision: true,
      durationMs: true,
      fileId: true,
    },
    orderBy: [{ adId: "asc" }, { versionNo: "asc" }],
  });
}
