import { createProductionMaterials } from "../delivery/index.js";
import type { ProductionMaterialsDeps } from "../delivery/index.js";
import { readMaterialMasters } from "../content/index.js";
import { readMaterialProfile } from "../profile/index.js";
import { readMaterialAdVersions } from "../ad/index.js";

/** Higher-layer assembly supplies each owner's factual reader to delivery. */
export function createRuntimeProductionMaterials(
  options: Omit<ProductionMaterialsDeps, "readMasters" | "readProfile" | "readAdVersions">,
) {
  return createProductionMaterials({
    ...options,
    readMasters: readMaterialMasters,
    readProfile: readMaterialProfile,
    readAdVersions: readMaterialAdVersions,
  });
}
