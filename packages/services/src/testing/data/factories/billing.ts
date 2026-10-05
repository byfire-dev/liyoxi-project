// 计费一侧：billing_account、payment_txn、billing_order、subscription_term、point_hold（07、08 分组）。
// 只插这几张表的行。账本的行（批次、分摊、流水、账户上的余额缓存）工厂不造：
// 要账本自洽的数据，经账本的服务函数造（W1-10）。
import { termDates } from "@liyoxi/shared/period";
import { endOfDay } from "@liyoxi/shared/time";

import { dateOnly, defined, fakeBizNo, seedMissing, sha256Hex } from "./context.js";
import type { FactoryContext } from "./context.js";
import { resolveScope, resolveTerm } from "./lookups.js";
import type { Factories, SubscriptionTermInput, TableFactories } from "./types.js";

type BillingFactories = Pick<
  TableFactories,
  "billingAccount" | "paymentTxn" | "billingOrder" | "subscriptionTerm" | "pointHold"
>;

const CONTENT_KIND: Record<string, string> = {
  plan_new: "plan",
  plan_renew: "plan",
  plan_upgrade: "upgrade",
  topup: "topup",
};

export function billingFactories(ctx: FactoryContext, make: Factories): BillingFactories {
  /** 套餐的价目版本：给了版本取它；给了套餐取它最新的一版；都没给取档次最低的套餐 */
  async function planRevision(input: SubscriptionTermInput) {
    if (input.planRevisionId !== undefined) {
      return ctx.db.planRevision.findUniqueOrThrow({ where: { id: input.planRevisionId } });
    }
    const plan =
      input.planId === undefined
        ? await ctx.db.plan.findFirst({ orderBy: { rank: "asc" } })
        : await ctx.db.plan.findUnique({ where: { id: input.planId } });
    const revision =
      plan &&
      (await ctx.db.planRevision.findFirst({
        where: { planId: plan.id, cancelledAt: null },
        orderBy: { revisionNo: "desc" },
      }));
    if (!revision) throw seedMissing("套餐与价目版本");
    return revision;
  }

  return {
    /** 缺省：没有订阅、余额为 0。一个主体一行 */
    async billingAccount(input = {}) {
      const now = ctx.now();
      return ctx.db.billingAccount.create({
        data: {
          createdAt: now,
          updatedAt: now,
          ...defined(input),
          entityId: input.entityId ?? (await make.entity()).id,
        },
      });
    },

    /** 缺省：一笔微信支付成功的流水，还没有归到哪张付款单上 */
    async paymentTxn(input = {}) {
      const id = input.id ?? ctx.id();
      const n = ctx.seq();
      const now = ctx.now();
      const amountFen = input.amountFen ?? 9900;
      const succeeded = (input.status ?? "succeeded") === "succeeded";
      return ctx.db.paymentTxn.create({
        data: {
          channel: "wechat_jsapi",
          attemptNo: 1,
          outTradeNo: id.replaceAll("-", ""),
          amountFen,
          status: "succeeded",
          ...(succeeded
            ? {
                channelAmountFen: amountFen,
                channelTxnNo: `4200009${String(n).padStart(21, "0")}`,
                channelSuccessAt: now,
              }
            : {}),
          createdAt: now,
          updatedAt: now,
          ...defined(input),
          id,
          entityId: input.entityId === undefined ? (await make.entity()).id : input.entityId,
        },
      });
    },

    /**
     * 缺省：小程序里下的新购套餐付款单，微信支付，已支付、已履约。
     * 已支付的付款单要一条成功的支付流水：没给 paidPaymentTxnId 时先造流水，插完付款单再把流水指回来。
     * 待确认（pending_confirmation）只有对公转账有，要自己给渠道与收款账户版本。
     */
    async billingOrder(input = {}) {
      const id = input.id ?? ctx.id();
      const n = ctx.seq();
      const now = ctx.now();
      const entityId = input.entityId ?? (await make.entity()).id;
      const status = input.status ?? "paid";
      const type = input.type ?? "plan_new";
      const amountFen = input.amountFen ?? 9900;
      const paid = status === "paid" || status === "refunded";
      const ownTxn =
        paid && input.paidPaymentTxnId === undefined
          ? await make.paymentTxn({ entityId, amountFen })
          : undefined;
      const order = await ctx.db.billingOrder.create({
        data: {
          orderNo: fakeBizNo("FK", ctx.today(), n),
          channel: "wechat_jsapi",
          source: "weapp",
          contentSnapshot: { kind: CONTENT_KIND[type] ?? type },
          quoteHash: sha256Hex(`quote:${id}`),
          expiresAt: new Date(now.getTime() + 30 * 60_000),
          ...(input.createdByStaffId == null
            ? {
                placedByUserId: (await ctx.db.entity.findUniqueOrThrow({ where: { id: entityId } }))
                  .createdByUserId,
              }
            : {}),
          ...(paid
            ? {
                paidAt: now,
                paidPaymentTxnId: ownTxn?.id,
                appliedAt: now,
                paidAmountFen: amountFen,
                fulfillmentStatus: "done",
                fulfilledAt: now,
              }
            : {}),
          ...(status === "refunded" ? { refundedAt: now, refundedAmountFen: amountFen } : {}),
          ...(status === "cancelled" ? { cancelledAt: now, cancelReason: "timeout" } : {}),
          createdAt: now,
          updatedAt: now,
          ...defined(input),
          id,
          entityId,
          type,
          status,
          amountFen,
        },
      });
      if (ownTxn) {
        await ctx.db.paymentTxn.update({
          where: { id: ownTxn.id },
          data: { billingOrderId: id, appliedAt: now },
        });
      }
      return order;
    },

    /**
     * 缺省：今天起一个月、生效中的一期，权益抄自种子里档次最低的套餐的最新价目版本，来源是一张已支付的付款单。
     * 一个主体同时只能有一期生效：已有生效的再造会被库拒掉，要第二期就给状态与起止日期。
     * 起止日期按北京时间；改 startsAt 要把 startDate、endDate、endsAt 一起给。
     */
    async subscriptionTerm(input = {}) {
      const now = ctx.now();
      const entityId = input.entityId ?? (await make.entity()).id;
      const revision = await planRevision(input);
      const months = input.months ?? 1;
      const dates = termDates(ctx.today(), months);
      const priceTotalFen = input.priceTotalFen ?? revision.monthlyFeeFen * months;
      const status = input.status ?? "active";
      return ctx.db.subscriptionTerm.create({
        data: {
          id: ctx.id(),
          termNo: 1,
          origin: "new",
          planId: revision.planId,
          planRevisionId: revision.id,
          initialPlanRevisionId: revision.id,
          monthlyEquivFen: revision.monthlyFeeFen,
          monthlyPoints: revision.monthlyPoints,
          discountBp: revision.discountBp,
          productionModel: revision.productionModel,
          maxStores: revision.maxStores,
          maxMembers: revision.maxMembers,
          schedulePriority: revision.schedulePriority,
          hasMonthlyReport: revision.hasMonthlyReport,
          anchorDay: dates.anchorDay,
          startDate: dateOnly(dates.startDate),
          endDate: dateOnly(dates.endDate),
          startsAt: now,
          endsAt: endOfDay(dates.endDate),
          ...(status === "scheduled" || status === "cancelled" ? {} : { activatedAt: now }),
          ...(status === "refunded" || status === "cancelled" ? { refundedAt: now } : {}),
          sourceBillingOrderId:
            input.sourceBillingOrderId ??
            (await make.billingOrder({ entityId, amountFen: priceTotalFen })).id,
          createdAt: now,
          updatedAt: now,
          ...defined(input),
          entityId,
          months,
          priceTotalFen,
          status,
        },
      });
    },

    /**
     * 缺省：给一个订单项冻结 100 积分，状态“冻结中”，系统发起。订阅周期没给时取主体生效中的那一期，没有才造。
     * 只是冻结单这一行：批次上的分摊与账户上的冻结合计不动。
     */
    async pointHold(input = {}) {
      const now = ctx.now();
      const { entityId, storeId } = await resolveScope(ctx, make, input);
      const term = await resolveTerm(ctx, make, entityId, input.subscriptionTermId);
      const status = input.status ?? "held";
      const qty = input.qty ?? 100;
      return ctx.db.pointHold.create({
        data: {
          id: ctx.id(),
          purpose: "order_item",
          refType: "order_item",
          refId: ctx.id(),
          pricingSnapshot: {},
          heldAt: now,
          actorType: "system",
          ...(status === "held" || status === "released" ? {} : { capturedAt: now }),
          ...(status === "released" || status === "refunded_full"
            ? { closedAt: now, returnedQty: qty }
            : {}),
          createdAt: now,
          updatedAt: now,
          ...defined(input),
          entityId,
          storeId,
          subscriptionTermId: term.id,
          status,
          qty,
        },
      });
    },
  };
}
