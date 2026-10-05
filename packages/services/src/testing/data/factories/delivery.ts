// 交付：delivery_ticket（10 分组）。只插工单这一行：环节记录、方案、样片不带。
import { defined } from "./context.js";
import type { FactoryContext } from "./context.js";
import type { Factories, TableFactories } from "./types.js";

/** 可以没有交付经理的环节 */
const NO_MANAGER = new Set(["assigning", "terminated"]);

export function deliveryFactories(
  ctx: FactoryContext,
  make: Factories,
): Pick<TableFactories, "deliveryTicket"> {
  return {
    /**
     * 缺省：待指派（assigning）的一张工单，等员工处理，7 天后是交付目标时间。
     * 订单项没给时造一个制作中的（连带制作中的订购单）；给了，订购单、短剧、主体、门店都取它的。
     * 工单号照规矩由订购单号派生：JF + 订购单号的数字部分 + “-” + 订单项序号。
     * 环节不是待指派、已终止时要有交付经理：没给就造一位。归档、终止的时间跟着环节补。
     */
    async deliveryTicket(input = {}) {
      const now = ctx.now();
      const step = input.step ?? "assigning";
      const item =
        input.orderItemId === undefined
          ? await make.orderItem({ phase: "producing" })
          : await ctx.db.orderItem.findUniqueOrThrow({ where: { id: input.orderItemId } });
      const order = await ctx.db.dramaOrder.findUniqueOrThrow({
        where: { id: item.dramaOrderId },
      });
      const deliveryManagerId =
        input.deliveryManagerId ?? (NO_MANAGER.has(step) ? undefined : (await make.staff()).id);
      return ctx.db.deliveryTicket.create({
        data: {
          id: ctx.id(),
          ticketNo: `JF${order.orderNo.replace(/\D/g, "")}-${item.itemNo}`,
          stepEnteredAt: now,
          waitingOn: "staff",
          deliveryTargetAt: new Date(now.getTime() + 7 * 24 * 3_600_000),
          ...(deliveryManagerId == null ? {} : { deliveryManagerId, assignedAt: now }),
          ...(step === "archived" ? { archivedAt: now } : {}),
          ...(step === "terminated" ? { terminatedAt: now } : {}),
          createdAt: now,
          updatedAt: now,
          ...defined(input),
          entityId: item.entityId,
          storeId: item.storeId,
          dramaOrderId: order.id,
          orderItemId: item.id,
          dramaId: item.dramaId,
          step,
        },
      });
    },
  };
}
