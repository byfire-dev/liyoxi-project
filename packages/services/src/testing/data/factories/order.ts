// 订购：drama_order、order_item（09 分组）。只插行：不冻结积分、不写状态历史、不发事件。
import { addDays } from "@liyoxi/shared/time";

import { dateOnly, defined, fakeBizNo } from "./context.js";
import type { FactoryContext } from "./context.js";
import { resolveScope, resolveTerm } from "./lookups.js";
import type { Factories, TableFactories } from "./types.js";

/** 各状态缺省的子状态（库里按状态限定子状态的取值）；没列的状态子状态为空 */
const DEFAULT_SUB_STATUS: Record<string, string> = {
  pending_start: "starting",
  producing: "assigning",
  to_launch: "awaiting_links",
  live: "in_service",
  cancelled: "cancelled_before_start",
};
const STARTED = new Set(["producing", "to_launch", "live", "ended", "refunded"]);
const CLOSED = new Set(["ended", "cancelled", "refunded"]);
/** 订单项还没扣减的阶段 */
const NOT_CAPTURED = new Set(["pending_start", "cancelled"]);

export function orderFactories(
  ctx: FactoryContext,
  make: Factories,
): Pick<TableFactories, "dramaOrder" | "orderItem"> {
  return {
    /**
     * 缺省：待开工（子状态 starting）的一张订购单，1 个订单项、合计 100 积分，带一条提交订购的同意记录。
     * 主体与门店都没给时，用“已认证、已开通套餐的商家”（make.subscribedMerchant）；给了就在给的上面补齐。
     * 换状态时子状态、开工时间、结束时间跟着补；售后中（after_sale）要自己给 openCancelRequestId。
     * 订单项不在这里造：要几项就调几次 make.orderItem，并把 itemCount、totalChargePoints 写成对得上的数。
     */
    async dramaOrder(input = {}) {
      const id = input.id ?? ctx.id();
      const n = ctx.seq();
      const now = ctx.now();
      const orderNo = input.orderNo ?? fakeBizNo("LYX", ctx.today(), n);
      const status = input.status ?? "pending_start";

      let { entityId, storeId, placedByUserId, subscriptionTermId } = input;
      if (entityId === undefined && storeId === undefined) {
        const merchant = await make.subscribedMerchant();
        entityId = merchant.entity.id;
        storeId = merchant.store.id;
        placedByUserId ??= merchant.user.id;
        subscriptionTermId ??= merchant.term.id;
      }
      const scope = await resolveScope(ctx, make, { entityId, storeId });
      placedByUserId ??= (await ctx.db.entity.findUniqueOrThrow({ where: { id: scope.entityId } }))
        .createdByUserId;
      const term = await resolveTerm(ctx, make, scope.entityId, subscriptionTermId);
      const plan = await ctx.db.plan.findUniqueOrThrow({ where: { id: term.planId } });
      const agreementConsentId =
        input.agreementConsentId ??
        (
          await make.agreementConsent({
            scene: "order_submit",
            merchantUserId: placedByUserId,
            ...scope,
            bizId: id,
            bizNo: orderNo,
          })
        ).id;
      return ctx.db.dramaOrder.create({
        data: {
          subStatus: DEFAULT_SUB_STATUS[status] ?? null,
          statusChangedAt: now,
          itemCount: 1,
          totalChargePoints: 100,
          planCode: plan.code,
          discountBp: term.discountBp,
          surchargeBp: 0,
          focusCodes: ["CF01"],
          submittedAt: now,
          ...(STARTED.has(status) ? { startedAt: now } : {}),
          ...(CLOSED.has(status) ? { closedAt: now } : {}),
          createdAt: now,
          updatedAt: now,
          ...defined(input),
          id,
          orderNo,
          ...scope,
          placedByUserId,
          subscriptionTermId: term.id,
          agreementConsentId,
          status,
        },
      });
    },

    /**
     * 缺省：待开工的一个订单项，3 集、标价与实扣都是 100 积分，带一张冻结单（冻结中）。
     * 订购单没给时造一张（状态跟着本项的阶段）；给了，主体、门店、订阅周期都取它的，序号取“已有项数 + 1”。
     * 换阶段时扣减时间、取消时间与原因、使用期起始日跟着补，冻结单的状态也跟着走。
     * 折扣取订购单的；折扣不是 10000 时实扣要自己给（工厂不算价）。
     */
    async orderItem(input = {}) {
      const id = input.id ?? ctx.id();
      const now = ctx.now();
      const phase = input.phase ?? "pending_start";
      const order =
        input.dramaOrderId === undefined
          ? await make.dramaOrder(
              phase === "terminated"
                ? { status: "cancelled", subStatus: "terminated_no_return" }
                : { status: phase },
            )
          : await ctx.db.dramaOrder.findUniqueOrThrow({ where: { id: input.dramaOrderId } });
      const captured = !NOT_CAPTURED.has(phase);
      const chargePoints = input.chargePoints ?? 100;
      const pointHoldId =
        input.pointHoldId ??
        (
          await make.pointHold({
            entityId: order.entityId,
            storeId: order.storeId,
            subscriptionTermId: order.subscriptionTermId,
            refId: id,
            qty: chargePoints,
            status: captured ? "captured" : phase === "cancelled" ? "released" : "held",
          })
        ).id;
      const dramaId = input.dramaId ?? (await make.drama()).id;
      return ctx.db.orderItem.create({
        data: {
          itemNo: (await ctx.db.orderItem.count({ where: { dramaOrderId: order.id } })) + 1,
          dramaSnapshot: { dramaId },
          episodeCount: 3,
          listPricePoints: chargePoints,
          discountBp: order.discountBp,
          surchargeBp: order.surchargeBp,
          pricingSnapshot: {},
          productionModel: "standard",
          phaseChangedAt: now,
          ...(captured ? { capturedAt: now } : {}),
          ...(phase === "cancelled"
            ? { cancelledAt: now, cancelReasonCode: "merchant_request" }
            : {}),
          ...(phase === "live" ? { usageStartDate: dateOnly(ctx.today()) } : {}),
          usageEndDate: dateOnly(addDays(ctx.today(), 365)),
          createdAt: now,
          updatedAt: now,
          ...defined(input),
          id,
          dramaOrderId: order.id,
          entityId: order.entityId,
          storeId: order.storeId,
          dramaId,
          chargePoints,
          pointHoldId,
          phase,
        },
      });
    },
  };
}
