import { billingOrderContentSchema } from "@liyoxi/contract";
import type { BillingOrderContent } from "@liyoxi/contract";
import type { BillingOrder } from "@liyoxi/db";
import type { Tx } from "../../kernel/index.js";

export interface PaymentOrderDescription {
  readonly orderNo: string;
  readonly paymentOrderId: string;
  readonly type: BillingOrder["type"];
  readonly title: string;
}

/** 卡片与跨域批量读口共用同一标题规则；套餐名由各自的只读查询提供。 */
export function paymentOrderTitle(
  type: BillingOrder["type"],
  content: BillingOrderContent,
  planName?: string,
): string {
  if (content.kind === "topup") return `加购积分 ${content.points.toLocaleString("zh-CN")}`;
  if (content.kind === "plan" && content.planName !== undefined)
    return `${type === "plan_renew" ? "续费" : "开通"}${content.planName} · ${content.months} 个月`;
  if (planName === undefined) throw new TypeError("付款单标题缺少关联套餐");
  if (content.kind === "upgrade") return `升级${planName}（本期剩余 ${content.remainingDays} 天）`;
  return `${type === "plan_renew" ? "续费" : "开通"}${planName} · ${content.months} 个月`;
}

/** m07 §1.2：只读本主体单号；旧快照的名称回查按批次完成，不随订单数增加查询。 */
export async function describePaymentOrders(
  tx: Tx,
  entityId: string,
  orderNos: readonly string[],
): Promise<PaymentOrderDescription[]> {
  const numbers = [...new Set(orderNos.filter((no) => no !== ""))];
  if (numbers.length === 0) return [];
  const orders = await tx.billingOrder.findMany({
    where: { entityId, orderNo: { in: numbers } },
    select: { id: true, orderNo: true, type: true, contentSnapshot: true },
  });
  const rows = orders.map((order) => ({
    order,
    content: billingOrderContentSchema.parse(order.contentSnapshot),
  }));
  const planIds = [
    ...new Set(
      rows.flatMap(({ content }) =>
        content.kind === "plan" && content.planName === undefined ? [content.planId] : [],
      ),
    ),
  ];
  const revisionIds = [
    ...new Set(
      rows.flatMap(({ content }) => (content.kind === "upgrade" ? [content.toPlanRevisionId] : [])),
    ),
  ];
  const plans = new Map(
    (planIds.length
      ? await tx.plan.findMany({ where: { id: { in: planIds } }, select: { id: true, name: true } })
      : []
    ).map((plan) => [plan.id, plan.name]),
  );
  const revisions = new Map(
    (revisionIds.length
      ? await tx.planRevision.findMany({
          where: { id: { in: revisionIds } },
          select: { id: true, plan: { select: { name: true } } },
        })
      : []
    ).map((revision) => [revision.id, revision.plan.name]),
  );
  return rows.map(({ order, content }) => ({
    orderNo: order.orderNo,
    paymentOrderId: order.id,
    type: order.type,
    title: paymentOrderTitle(
      order.type,
      content,
      content.kind === "plan"
        ? plans.get(content.planId)
        : content.kind === "upgrade"
          ? revisions.get(content.toPlanRevisionId)
          : undefined,
    ),
  }));
}
