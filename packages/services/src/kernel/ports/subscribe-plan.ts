// W2-18：identity 的引导只读槽位，经注入读取，不上引购买策略或通知的业务表。
import type { Bootstrap } from "@liyoxi/contract";
import { definePort } from "../assembly/index.js";
import type { Assembly } from "../assembly/index.js";
import type { Tx } from "../tx.js";

export interface SubscribePlanQuery {
  readonly platform: string;
  readonly clientVersion?: string;
  /** 只接受经成员关系验证的主体；未指定门店时为空。 */
  readonly entityId: string | null;
  readonly now: Date;
}
export type SubscribePlanReader = (
  tx: Tx,
  query: SubscribePlanQuery,
) => Promise<NonNullable<Bootstrap["subscribePlan"]>>;
export const subscribePlanPort = definePort<SubscribePlanReader>("bootstrap.subscribe_plan", {
  fallback: async () => [],
});
export function subscribePlanOf(assembly: Pick<Assembly, "port">): SubscribePlanReader {
  return assembly.port(subscribePlanPort);
}
