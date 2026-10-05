// identity 模块：商家用户的状态迁移表。
// 每行：分组文档的行（分组:行号）、当前状态（null 是新建）、迁移事件码、新状态（SAME 是不改状态）；文档没写守卫的行尾是 NO_GUARD。
// 改这里的行，要在同一个 PR 改分组文档的那一行：pnpm machines:check 逐行对照。
import { MERCHANT_USER_STATUS } from "@liyoxi/contract/enums";

import { chain } from "./define.js";

/** merchant_user.status：docs/data-model/02-identity-tenant.md */
export const merchantUser = chain("merchant_user", "status", MERCHANT_USER_STATUS, [
  ["02:125", null, "merchant_user.register", ["active"]],
  ["02:126", ["active"], "merchant_user.disable", ["disabled"]],
  ["02:127", ["disabled"], "merchant_user.enable", ["active"]],
  ["02:128", ["active"], "merchant_user.delete", ["deleted"]],
  ["02:129", ["active"], "merchant_user.purge_empty", ["deleted"]],
]);
