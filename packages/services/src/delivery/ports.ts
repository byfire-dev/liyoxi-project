import type { PlanContent } from "@liyoxi/contract";
import { AppError, definePort } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { getLaunchFacts } from "../publish/index.js";

/** W1-17 接管订单写侧；调用方已持有 order 160 → item 170 → ticket 180 → account 190 → plan 200。
 * 实现只能使用同一事务，不能重开事务、后锁父行或再锁别的主体账户。
 */
export interface OrderSide {
  applyConfirmedPlan(
    tx: Tx,
    input: {
      ctx: IdentityContext;
      dramaOrderId: string;
      deliveryPlanId: string;
      versionNo: number;
      content: PlanContent;
    },
  ): Promise<void>;
  rederive(
    tx: Tx,
    input: {
      orderItemIds: readonly string[];
      launchFacts?: Awaited<ReturnType<typeof getLaunchFacts>>;
    },
  ): Promise<void>;
}
export const orderSidePort = definePort<OrderSide>("delivery.order_side", {
  fallback: {
    async applyConfirmedPlan() {
      throw new AppError("INTERNAL");
    },
    async rederive() {},
  },
});
