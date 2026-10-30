import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

export interface LicenseeFacts {
  name: string;
  usccEnc: string;
  store: string;
}

/** 内部快照专用密文事实；解密只可留在组合根注入链，不能进入常规 DTO 或失败日志。 */
export async function readLicenseeFacts(
  tx: Tx,
  input: { entityId: string; storeId: string },
): Promise<LicenseeFacts> {
  const store = await tx.store.findFirst({
    where: { id: input.storeId, entityId: input.entityId },
    select: { name: true, entity: { select: { name: true, usccEnc: true } } },
  });
  if (!store?.name?.trim() || !store.entity.name?.trim() || !store.entity.usccEnc?.trim())
    throw new AppError("PRECONDITION_CHANGED", { message: "授权快照所需的主体或门店事实不完整" });
  return { name: store.entity.name, usccEnc: store.entity.usccEnc, store: store.name };
}
