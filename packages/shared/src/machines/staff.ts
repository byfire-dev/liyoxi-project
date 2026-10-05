// staff 模块：员工的状态迁移表。
// 每行：分组文档的行（分组:行号）、当前状态（null 是新建）、迁移事件码、新状态（SAME 是不改状态）；文档没写守卫的行尾是 NO_GUARD。
// 改这里的行，要在同一个 PR 改分组文档的那一行：pnpm machines:check 逐行对照。
import { STAFF_STATUS } from "@liyoxi/contract/enums";

import { chain } from "./define.js";

/** staff.status：docs/data-model/03-staff-authz-audit.md */
export const staff = chain("staff", "status", STAFF_STATUS, [
  ["03:217", null, "staff.bootstrap", ["active"]],
  ["03:218", null, "staff.create", ["active"]],
  ["03:219", null, "staff.create", ["pending"]],
  ["03:220", ["pending"], "staff.enable", ["active"]],
  ["03:221", ["active"], "staff.disable", ["disabled"]],
  ["03:222", ["disabled"], "staff.enable", ["active"]],
]);
