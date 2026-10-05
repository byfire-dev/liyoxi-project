// 商家端：客服、消息与通用接口 · service-tickets（docs/api/m08-support-misc.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mServiceTicketList = merchantMeta({
  method: "get",
  path: "/m/service-tickets",
  operationId: "m.serviceTicket.list",
  summary: "我的工单：类型、状态、标题、日期、关联订单",
  "x-capability": "ticket.*",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mServiceTicketCreate = merchantMeta({
  method: "post",
  path: "/m/service-tickets",
  operationId: "m.serviceTicket.create",
  summary:
    "提交工单：{typeCode, orderId?, description ≤500, imageFileIds ≤9, phoneSource, contactPhone?}；取号 KF…，轮流分配当班客服",
  "x-capability": "ticket.*",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});

export const mServiceTicketGet = merchantMeta({
  method: "get",
  path: "/m/service-tickets/{serviceTicketId}",
  operationId: "m.serviceTicket.get",
  summary:
    "工单详情：工单号、状态与进度条、类型、关联订单、处理人、自动解决时刻；处理记录（只含商家可见条目，系统事件带深链按钮）",
  "x-capability": "ticket.*",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mServiceTicketConfirm = merchantMeta({
  method: "post",
  path: "/m/service-tickets/{serviceTicketId}/confirm",
  operationId: "m.serviceTicket.confirm",
  summary: "确认已解决",
  "x-capability": "ticket.*",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});

export const mServiceTicketEntryCreate = merchantMeta({
  method: "post",
  path: "/m/service-tickets/{serviceTicketId}/entries",
  operationId: "m.serviceTicket.entry.create",
  summary: "补充说明（≤500 字、1 张图），提醒处理人",
  "x-capability": "ticket.*",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});

export const mServiceTicketRate = merchantMeta({
  method: "post",
  path: "/m/service-tickets/{serviceTicketId}/rate",
  operationId: "m.serviceTicket.rate",
  summary: "V1.1：工单解决后评价服务（1～5 星）",
  "x-capability": "ticket.*",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});

export const mServiceTicketReopen = merchantMeta({
  method: "post",
  path: "/m/service-tickets/{serviceTicketId}/reopen",
  operationId: "m.serviceTicket.reopen",
  summary: "仍未解决、重新打开 {note}（待您确认，或已解决不超过参数天数）",
  "x-capability": "ticket.*",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});

export const mServiceTicketWithdraw = merchantMeta({
  method: "post",
  path: "/m/service-tickets/{serviceTicketId}/withdraw",
  operationId: "m.serviceTicket.withdraw",
  summary: "撤回工单 {reasonCode}（问题已解决/不再需要/重复提交/其他）",
  "x-capability": "ticket.*",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});
