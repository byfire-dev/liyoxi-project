import { derived, entry, type StatusToneGroup } from "./types.js";

/** 单部剧：订单项的展示状态，由订单项阶段与交付工单步骤合起来看（接口 m04 的 ticketStep） */
export const orderItem: StatusToneGroup = {
  key: "order-item",
  object: "单部剧",
  entries: [
    derived(
      "样片制作中",
      "info",
      "info",
      "无枚举对应：订单项所属工单的步骤为 sample_making（delivery_ticket.step）时的叫法",
    ),
    derived(
      "样片待确认",
      "warning",
      "info",
      "无枚举对应：订单项所属工单的步骤为 sample_confirm（delivery_ticket.step）时的叫法",
    ),
    entry("上线中", "order_item.phase", ["live"], "success", "success"),
  ],
};
