import { billingOrderContentSchema } from "@liyoxi/contract";
import type { StoreHeader } from "@liyoxi/contract";
import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { getWalletView } from "./index.js";

export interface TenantAdminBillingFacts {
  readonly subscription: StoreHeader["subscription"];
  readonly spendablePoints: number;
}

async function paymentTitle(tx: Tx, type: string, snapshot: unknown): Promise<string> {
  const parsed = billingOrderContentSchema.safeParse(snapshot);
  const kinds: Readonly<Record<string, string>> = {
    plan_new: "plan",
    plan_renew: "plan",
    plan_upgrade: "upgrade",
    topup: "topup",
  };
  if (!parsed.success || kinds[type] !== parsed.data.kind) throw new AppError("INTERNAL");
  const content = parsed.data;
  if (content.kind === "topup")
    return `加购积分 ${String(content.points).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
  let planId: string;
  if (content.kind === "upgrade") {
    const revision = await tx.planRevision.findUnique({
      where: { id: content.toPlanRevisionId },
      select: { planId: true },
    });
    if (!revision) throw new AppError("INTERNAL");
    planId = revision.planId;
  } else planId = content.planId;
  const plan = await tx.plan.findUnique({ where: { id: planId }, select: { name: true } });
  if (!plan) throw new AppError("INTERNAL");
  return content.kind === "upgrade"
    ? `升级${plan.name}（本期剩余 ${content.remainingDays} 天）`
    : `${type === "plan_new" ? "开通" : "续费"}${plan.name} · ${content.months} 个月`;
}

/** 后台主体摘要只读调用方事务；不推进账本、不读余额/订阅状态缓存。 */
export async function readTenantAdminBillingFacts(
  tx: Tx,
  input: { readonly entityId: string; readonly now: Date },
): Promise<TenantAdminBillingFacts> {
  const { entityId, now } = input;
  const [entity, account] = await Promise.all([
    tx.entity.findUnique({ where: { id: entityId }, select: { id: true } }),
    tx.billingAccount.findUnique({ where: { entityId }, select: { entityId: true } }),
  ]);
  if (!entity) throw new AppError("NOT_FOUND");
  if (!account) throw new AppError("INTERNAL");
  const [wallet, scheduled] = await Promise.all([
    getWalletView(tx, entityId, now),
    tx.subscriptionTerm.count({ where: { entityId, status: "scheduled" } }),
  ]);
  const s = wallet.subscription;
  // 当前/最近周期存在时，缺套餐引用不是“从未开通”。
  if (s.status !== "none" && s.plan === null) throw new AppError("INTERNAL");
  const order =
    s.status === "active"
      ? null
      : await tx.billingOrder.findFirst({
          where: { entityId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            orderNo: true,
            type: true,
            status: true,
            contentSnapshot: true,
            refundedAt: true,
          },
        });
  return {
    subscription: {
      status: s.status,
      plan: s.plan,
      months: s.months,
      startDate: s.startDate,
      endDate: s.endDate,
      hasScheduledTerm: scheduled > 0,
      isRefundPending: s.isRefundPending,
      latestPaymentOrder: order
        ? {
            paymentOrderId: order.id,
            orderNo: order.orderNo,
            type: order.type,
            status: order.status,
            title: await paymentTitle(tx, order.type, order.contentSnapshot),
            refundedAt: order.refundedAt?.toISOString() ?? null,
          }
        : null,
    },
    spendablePoints: wallet.points.spendablePoints,
  };
}
