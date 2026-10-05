// 后台：客服工单 · service-tickets（docs/api/a08-support.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminServiceTicketList = adminMeta({
  method: "get",
  path: "/admin/service-tickets",
  operationId: "admin.serviceTicket.list",
  summary:
    "客服工单池：状态页签、工单号 / 商家 / 单号搜索、类型、优先级、来源、负责人、仅看响应超时；待处理类按时效排序",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminServiceTicketCreate = adminMeta({
  method: "post",
  path: "/admin/service-tickets",
  operationId: "admin.serviceTicket.create",
  summary:
    "登记工单（电话、在线客服来源）：商家、关联单号、类型、优先级、负责人（轮流或指定）、描述；直接进入处理中",
  "x-permission": "service.ticket.register",
  "x-idempotent": "required",
});

export const adminServiceTicketSummary = adminMeta({
  method: "get",
  path: "/admin/service-tickets/summary",
  operationId: "admin.serviceTicket.summary",
  summary: "页首摘要与页签计数：待处理、响应超时、今日已解决",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminServiceTicketGet = adminMeta({
  method: "get",
  path: "/admin/service-tickets/{serviceTicketId}",
  operationId: "admin.serviceTicket.get",
  summary:
    "工单详情：处理记录时间线（商家消息、回复、内部备注、系统事件）、服务时效、工单信息、关联业务",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminServiceTicketUpdate = adminMeta({
  method: "patch",
  path: "/admin/service-tickets/{serviceTicketId}",
  operationId: "admin.serviceTicket.update",
  summary: "改问题类型、优先级（带 lockVersion；只限未结状态）",
  "x-permission": "service.ticket.reply",
  "x-idempotent": "required",
});

export const adminServiceTicketAssign = adminMeta({
  method: "post",
  path: "/admin/service-tickets/{serviceTicketId}/assign",
  operationId: "admin.serviceTicket.assign",
  summary: "分配负责人（负责人为空时；必选原因）；企业微信提醒，时限不变",
  "x-permission": "service.ticket.assign",
  "x-idempotent": "required",
});

export const adminServiceTicketClose = adminMeta({
  method: "post",
  path: "/admin/service-tickets/{serviceTicketId}/close",
  operationId: "admin.serviceTicket.close",
  summary: "关闭工单（原因：重复、无效、商家撤回；说明必填）；关闭后不能再回复",
  "x-permission": "service.ticket.close",
  "x-idempotent": "required",
});

export const adminServiceTicketEntryCreate = adminMeta({
  method: "post",
  path: "/admin/service-tickets/{serviceTicketId}/entries",
  operationId: "admin.serviceTicket.entry.create",
  summary: "回复商家或写内部备注（≤500 字，可带图片；可勾选“此回复为处理方案”）",
  "x-permission": "service.ticket.reply",
  "x-idempotent": "required",
});

export const adminServiceTicketRefCreate = adminMeta({
  method: "post",
  path: "/admin/service-tickets/{serviceTicketId}/refs",
  operationId: "admin.serviceTicket.ref.create",
  summary: "处理中补关联业务（订购单、付款单、交付工单、广告；对象须属本门店，付款单按主体）",
  "x-permission": "service.ticket.reply",
  "x-idempotent": "required",
});

export const adminServiceTicketRefBatchRemove = adminMeta({
  method: "post",
  path: "/admin/service-tickets/{serviceTicketId}/refs/remove",
  operationId: "admin.serviceTicket.ref.batchRemove",
  summary: "移除关联错的业务（物理删除，M95；审批单关联不可移除）",
  "x-permission": "service.ticket.reply",
  "x-idempotent": "required",
});

export const adminServiceTicketForceTransition = adminMeta({
  method: "post",
  path: "/admin/service-tickets/{serviceTicketId}/force-transition",
  operationId: "admin.serviceTicket.forceTransition",
  summary: "人工纠偏：把误关闭的客服工单重新打开（closed → processing；原因不少于 10 字）",
  "x-permission": "flow.admin.transition",
  "x-idempotent": "required",
});

export const adminServiceTicketReassign = adminMeta({
  method: "post",
  path: "/admin/service-tickets/{serviceTicketId}/reassign",
  operationId: "admin.serviceTicket.reassign",
  summary: "转派（目标员工启用且非当前负责人；必选原因，说明写入内部备注）",
  "x-permission": "service.ticket.transfer",
  "x-idempotent": "required",
});

export const adminServiceTicketSubmitResult = adminMeta({
  method: "post",
  path: "/admin/service-tickets/{serviceTicketId}/submit-result",
  operationId: "admin.serviceTicket.submitResult",
  summary: "提交处理结果（必填），进入待商家确认，3 天未确认自动解决",
  "x-permission": "service.ticket.reply",
  "x-idempotent": "required",
});
