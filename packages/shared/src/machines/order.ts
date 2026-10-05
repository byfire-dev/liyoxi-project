// order 模块：订购单、订单项、取消申请的状态迁移表。
// 每行：分组文档的行（分组:行号）、当前状态（null 是新建）、迁移事件码、新状态（SAME 是不改状态）；文档没写守卫的行尾是 NO_GUARD。
// 改这里的行，要在同一个 PR 改分组文档的那一行：pnpm machines:check 逐行对照。
import {
  CANCEL_REQUEST_STATUS,
  DRAMA_ORDER_STATUS,
  ORDER_ITEM_PHASE,
  type EnumValue,
} from "@liyoxi/contract/enums";

import { NO_GUARD, chain } from "./define.js";

/** 订购单的未关闭状态：还有未关闭的订单项时，取其中最靠前的阶段（09 分组“推导条件”表） */
const UNCLOSED = [
  "pending_start",
  "producing",
  "to_launch",
  "live",
  "ended",
] as const satisfies readonly EnumValue<typeof DRAMA_ORDER_STATUS>[];

/**
 * drama_order.status：docs/data-model/09-order-ad.md。
 * 订购单没有自己的事件驱动状态机：状态由订单项阶段与在途取消推导后物化。分组文档给的是“会触发重新推导的写入点”一张表，
 * 除新建与开工外都记成 order.rederive；那张表没有“守卫”一栏。
 */
export const dramaOrder = chain("drama_order", "status", DRAMA_ORDER_STATUS, [
  ["09:196", null, "order.submit", ["pending_start"], NO_GUARD],
  ["09:197", ["pending_start"], "order.start", ["producing"]],
  [
    "09:198",
    ["producing", "to_launch", "live", "ended"],
    "order.rederive",
    ["producing", "to_launch", "live", "ended"],
    NO_GUARD,
  ],
  ["09:199", UNCLOSED, "order.rederive", ["after_sale"], NO_GUARD],
  ["09:200", ["after_sale"], "order.rederive", UNCLOSED, NO_GUARD],
  ["09:201", ["after_sale"], "order.rederive", ["cancelled", "refunded", ...UNCLOSED], NO_GUARD],
]);

/** order_item.phase：docs/data-model/09-order-ad.md */
export const orderItem = chain("order_item", "phase", ORDER_ITEM_PHASE, [
  ["09:351", null, "order.submit", ["pending_start"]],
  ["09:352", ["pending_start"], "order.start", ["producing"]],
  ["09:353", ["pending_start"], "cancel.execute", ["cancelled"]],
  ["09:354", ["producing", "to_launch"], "ticket.terminate", ["refunded", "terminated"]],
  ["09:355", ["producing"], "package.pushed", ["to_launch"]],
  ["09:356", ["to_launch"], "launch.changed", ["live"]],
  ["09:357", ["live"], "launch.verify_revoked", ["to_launch"]],
  ["09:358", ["to_launch", "live"], "takedown.all_checked", ["ended", "refunded"]],
]);

/** cancel_request.status：docs/data-model/09-order-ad.md */
export const cancelRequest = chain("cancel_request", "status", CANCEL_REQUEST_STATUS, [
  ["09:547", null, "cancel.submit", ["pending_approval"]],
  ["09:548", ["pending_approval"], "approval.approved", ["pending_execution"]],
  ["09:549", ["pending_approval"], "approval.rejected", ["not_executed"], NO_GUARD],
  ["09:550", ["pending_approval"], "approval.withdrawn", ["not_executed"], NO_GUARD],
  ["09:551", ["pending_execution"], "cancel.execute", ["done"]],
  ["09:552", ["pending_execution"], "cancel.void", ["not_executed"]],
  ["09:553", ["pending_approval"], "cancel.auto_execute", ["done"]],
]);
