import type { PlanContent } from "@liyoxi/contract";
import { AppError, definePort } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { getLaunchFacts } from "../publish/index.js";

export interface CancelReviewCause {
  readonly requestId: string;
  readonly approvalRequestId: string;
  readonly lineIds: readonly string[];
  readonly lines: readonly { id: string; targetType: string; targetId: string }[];
  readonly entityId: string;
  readonly storeId: string;
  readonly orderItemIds: readonly string[];
  readonly orderItems: readonly { id: string; dramaId: string; dramaOrderId: string }[];
  readonly approvalStatus: "pending" | "approved";
  readonly submitActorType: "staff" | "system";
  readonly submitActorId: string | null;
  readonly submitClient: string | null;
}

/** W1-17 接管订单写侧；调用方已持有 order 160 → item 170 → ticket 180 → account 190 → plan 200。
 * 实现只能使用同一事务，不能重开事务、后锁父行或再锁别的主体账户。
 */
export interface OrderSide {
  /** Same-Tx owner read; rejects malformed/closed cancellation and actual approval associations. */
  readCancelReviewCause(tx: Tx, approvalRequestId: string): Promise<CancelReviewCause>;
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
    async readCancelReviewCause() {
      throw new AppError("INTERNAL", { message: "取消暂停缺少订单事实拥有者" });
    },
    async applyConfirmedPlan() {
      throw new AppError("INTERNAL");
    },
    async rederive() {},
  },
});
