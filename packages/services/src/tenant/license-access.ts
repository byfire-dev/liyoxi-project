import type { Tx } from "../kernel/index.js";
import { storeScope } from "../authz/index.js";
import type { DataScope } from "../authz/index.js";

/** Current owner only, including an archived store's owner; no cached membership assertion. */
export async function isLicenseOwner(
  tx: Tx,
  input: { merchantUserId: string; entityId: string },
): Promise<boolean> {
  return (
    (await tx.entityMember.findFirst({
      where: {
        merchantUserId: input.merchantUserId,
        entityId: input.entityId,
        role: "owner",
        status: "active",
      },
      select: { id: true },
    })) !== null
  );
}

/** Owner-provided order facts give only ids; the tenant owner applies issued staff data scope. */
export async function licenseStoreVisible(
  tx: Tx,
  input: { entityId: string; storeId: string; scope: DataScope },
): Promise<boolean> {
  return (
    (await tx.store.findFirst({
      where: { id: input.storeId, entityId: input.entityId, ...storeScope(input.scope) },
      select: { id: true },
    })) !== null
  );
}
