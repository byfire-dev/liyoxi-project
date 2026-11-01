import { AdminStoreBriefSchema } from "@liyoxi/contract";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

/** Called after ad owner scope validation; exposes no profile private or PII fields. */
export async function readAdTaskStore(tx: Tx, input: { entityId: string; storeId: string }) {
  const store = await tx.store.findFirst({
    where: { id: input.storeId, entityId: input.entityId },
    select: {
      id: true,
      name: true,
      entityId: true,
      qualificationStatus: true,
      deliveryManagerId: true,
      entity: { select: { name: true } },
      storeProfileStore: { select: { cityCode: true, districtCode: true } },
    },
  });
  if (!store) throw new AppError("NOT_FOUND");
  const city = store.storeProfileStore?.cityCode ?? null,
    district = store.storeProfileStore?.districtCode ?? null;
  const dicts = await tx.dictItem.findMany({
    where: {
      dictTypeKey: "region",
      code: { in: [city, district].filter((x): x is string => x !== null) },
    },
    select: { code: true, name: true },
  });
  const ref = (code: string | null) =>
    code === null ? null : { code, name: dicts.find((x) => x.code === code)?.name ?? code };
  return {
    store: AdminStoreBriefSchema.parse({
      storeId: store.id,
      storeName: store.name,
      entityId: store.entityId,
      entityName: store.entity.name,
      city: ref(city),
      district: ref(district),
      qualificationStatus: store.qualificationStatus,
    }),
    deliveryManagerId: store.deliveryManagerId,
  };
}
