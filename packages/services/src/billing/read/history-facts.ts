import type { Tx } from "../../kernel/index.js";
import type { BillingHistoryFacts } from "../../tenant/index.js";

/** 历史是否存在只认真实行；双 EXISTS 在调用方事务的同一语句快照读取。 */
export async function readBillingHistoryFacts(
  tx: Tx,
  entityId: string,
): Promise<BillingHistoryFacts> {
  const [facts] = await tx.$queryRaw<BillingHistoryFacts[]>`
    SELECT
      EXISTS (SELECT 1 FROM subscription_term WHERE entity_id = ${entityId}::uuid)
        AS "hasSubscriptionTerm",
      EXISTS (SELECT 1 FROM billing_order WHERE entity_id = ${entityId}::uuid)
        AS "hasBillingOrder"`;
  if (
    facts === undefined ||
    typeof facts.hasSubscriptionTerm !== "boolean" ||
    typeof facts.hasBillingOrder !== "boolean"
  ) {
    throw new Error("计费历史事实读取结果无效");
  }
  return {
    hasSubscriptionTerm: facts.hasSubscriptionTerm,
    hasBillingOrder: facts.hasBillingOrder,
  };
}
