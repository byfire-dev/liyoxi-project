import { requireAdProductionAccess } from "../ad/index.js";
import { requireProductionAccess } from "../delivery/index.js";
import { AppError } from "../kernel/index.js";
import type { ProductionAccess } from "../media/index.js";

/** Media receives one lower-layer callback; each actual parent is read by its owner. */
export const requireRuntimeProductionAccess: ProductionAccess["require"] = (
  tx,
  actor,
  parent,
  permission,
) => {
  if ((parent.orderItemId === null) === (parent.adId === null)) throw new AppError("NOT_FOUND");
  return parent.adId
    ? requireAdProductionAccess(tx, actor, parent.adId, permission)
    : requireProductionAccess(tx, actor, parent, permission);
};
