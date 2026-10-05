// support 模块：客服工单的状态迁移表。
// 每行：分组文档的行（分组:行号）、当前状态（null 是新建）、迁移事件码、新状态（SAME 是不改状态）；文档没写守卫的行尾是 NO_GUARD。
// 改这里的行，要在同一个 PR 改分组文档的那一行：pnpm machines:check 逐行对照。
import { SERVICE_TICKET_STATUS } from "@liyoxi/contract/enums";

import { NO_GUARD, SAME, chain } from "./define.js";

/** service_ticket.status：docs/data-model/12-support.md */
export const serviceTicket = chain("service_ticket", "status", SERVICE_TICKET_STATUS, [
  ["12:149", null, "submit", ["pending"]],
  ["12:150", null, "register", ["processing"]],
  ["12:151", ["pending"], "reply", ["processing"]],
  ["12:153", ["processing"], "submit_result", ["awaiting_confirm"]],
  ["12:154", ["awaiting_confirm"], "confirm", ["resolved"], NO_GUARD],
  ["12:155", ["awaiting_confirm"], "auto_resolve", ["resolved"]],
  ["12:156", ["awaiting_confirm", "resolved"], "reopen", ["processing"]],
  ["12:157", ["pending", "processing"], "withdraw", ["closed"]],
  ["12:158", ["pending", "processing", "awaiting_confirm"], "close", ["closed"]],
  ["12:159", ["pending", "processing", "awaiting_confirm"], "assign", SAME],
  ["12:160", ["pending", "processing", "awaiting_confirm"], "transfer", SAME],
  ["12:161", ["pending", "processing"], "escalate", SAME],
  ["12:162", ["closed"], "admin.force", ["processing"]],
]);
