// 03 §3.3、09 §2.2/2.3：纯推导；不取时钟、不查库，事实由调用方传入。
import { ORDER_ITEM_PHASE, type EnumValue, type DRAMA_ORDER_STATUS } from "@liyoxi/contract/enums";

export type ItemPhase = EnumValue<typeof ORDER_ITEM_PHASE>;
export type OrderStatus = EnumValue<typeof DRAMA_ORDER_STATUS>;
export const PRODUCING_STEPS = [
  "assigning",
  "plan_confirm",
  "ad_prep",
  "sample_making",
  "sample_confirm",
  "batch_compose",
  "delivering",
] as const;
export const ACTIVE_PHASES = ["pending_start", "producing", "to_launch", "live", "ended"] as const;

export function phaseFromTicket(
  step: string,
  hasLaunched: boolean,
  actualReturnedPoints: number,
): ItemPhase {
  if (!Number.isSafeInteger(actualReturnedPoints) || actualReturnedPoints < 0)
    throw new RangeError("实际退回积分必须是非负整数");
  switch (step) {
    case "assigning":
    case "plan_confirm":
    case "ad_prep":
    case "sample_making":
    case "sample_confirm":
    case "batch_compose":
    case "delivering":
      return "producing";
    case "awaiting_launch":
    case "launch_verify":
      return "to_launch";
    case "in_service":
      return "live";
    case "takedown":
      return hasLaunched ? "live" : "to_launch";
    case "archived":
      return actualReturnedPoints > 0 ? "refunded" : "ended";
    case "terminated":
      return actualReturnedPoints > 0 ? "refunded" : "terminated";
    default:
      throw new TypeError(`未知交付工单步骤：${step}`);
  }
}
export function orderStatus(
  items: readonly { phase: string }[],
  hasOpenAfterSale: boolean,
): OrderStatus {
  if (items.length === 0) throw new RangeError("订购单必须有订单项");
  for (const item of items)
    if (!(ORDER_ITEM_PHASE.values as readonly string[]).includes(item.phase))
      throw new TypeError(`未知订单项阶段：${item.phase}`);
  if (hasOpenAfterSale) return "after_sale";
  for (const phase of ACTIVE_PHASES) if (items.some((item) => item.phase === phase)) return phase;
  return items.some((item) => item.phase === "refunded") ? "refunded" : "cancelled";
}
export interface SubStatusItem {
  readonly phase: string;
  readonly ticketStep?: string | null;
  readonly launchState?: "awaiting_links" | "verifying" | "need_fix" | "expired_unlaunched";
  readonly liveState?: "in_service" | "takedown_pending" | "takedown_overdue";
}
export function orderSubStatus(input: {
  readonly status: OrderStatus;
  readonly items: readonly SubStatusItem[];
  readonly qualificationStatus?: string;
  readonly cancelRequestStatus?: string | null;
}): string | null {
  const items = input.items.filter((item) => item.phase === input.status);
  switch (input.status) {
    case "pending_start":
      return input.qualificationStatus === "rejected"
        ? "qualification_rejected"
        : input.qualificationStatus === "verified"
          ? "starting"
          : "qualification_reviewing";
    case "producing":
      return (
        PRODUCING_STEPS.find((step) => items.some((item) => item.ticketStep === step)) ??
        "assigning"
      );
    case "to_launch": {
      const first = items.find((i) => i.ticketStep === "awaiting_launch") ?? items[0];
      return (
        first?.launchState ??
        (first?.ticketStep === "launch_verify" ? "verifying" : "awaiting_links")
      );
    }
    case "live": {
      const first = items.find((i) => i.ticketStep === "in_service") ?? items[0];
      return (
        first?.liveState ?? (first?.ticketStep === "takedown" ? "takedown_pending" : "in_service")
      );
    }
    case "after_sale":
      return input.cancelRequestStatus === "pending_execution"
        ? "refund_executing"
        : "cancel_reviewing";
    case "cancelled":
      return input.items.some((item) => item.phase === "terminated")
        ? "terminated_no_return"
        : "cancelled_before_start";
    case "ended":
    case "refunded":
      return null;
  }
}
