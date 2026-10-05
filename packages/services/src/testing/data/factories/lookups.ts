// 几个工厂共用的“上级行怎么定”（W0-25）：给了就用给的，没给的按外键顺序现造，并保证同属一个主体。
import type { SubscriptionTerm } from "@liyoxi/db";

import type { FactoryContext } from "./context.js";
import type { Factories } from "./types.js";

/**
 * 主体与门店：两个都给了照用；只给门店，主体取门店的；只给主体，在它名下造一家门店；
 * 都没给，造一家门店（连带它的主体）。
 */
export async function resolveScope(
  ctx: FactoryContext,
  make: Factories,
  input: { entityId?: string | null; storeId?: string | null },
): Promise<{ entityId: string; storeId: string }> {
  const { entityId, storeId } = input;
  if (entityId != null && storeId != null) return { entityId, storeId };
  if (storeId != null) {
    const store = await ctx.db.store.findUniqueOrThrow({ where: { id: storeId } });
    return { entityId: store.entityId, storeId };
  }
  const store = await make.store(entityId == null ? {} : { entityId });
  return { entityId: store.entityId, storeId: store.id };
}

/** 订阅周期：给了 id 就取那一期；没给，先找这个主体生效中的一期，没有才造 */
export async function resolveTerm(
  ctx: FactoryContext,
  make: Factories,
  entityId: string,
  subscriptionTermId?: string,
): Promise<SubscriptionTerm> {
  if (subscriptionTermId !== undefined) {
    return ctx.db.subscriptionTerm.findUniqueOrThrow({ where: { id: subscriptionTermId } });
  }
  return (
    (await ctx.db.subscriptionTerm.findFirst({ where: { entityId, status: "active" } })) ??
    (await make.subscriptionTerm({ entityId }))
  );
}
