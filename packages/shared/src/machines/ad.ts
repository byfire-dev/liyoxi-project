// ad 模块：广告的状态迁移表。
// 每行：分组文档的行（分组:行号）、当前状态（null 是新建）、迁移事件码、新状态（SAME 是不改状态）；文档没写守卫的行尾是 NO_GUARD。
// 改这里的行，要在同一个 PR 改分组文档的那一行：pnpm machines:check 逐行对照。
import { AD_STATUS } from "@liyoxi/contract/enums";

import { chain } from "./define.js";

/** ad.status：docs/data-model/09-order-ad.md */
export const ad = chain("ad", "status", AD_STATUS, [
  ["09:801", null, "ad.submit", ["pending_assign"]],
  ["09:802", ["pending_assign"], "ad.assign", ["producing"]],
  ["09:803", ["pending_assign", "producing"], "ad.return", ["returned"]],
  ["09:804", ["returned"], "ad.resubmit", ["pending_assign", "producing"]],
  ["09:805", ["producing", "revising"], "ad.push_version", ["pending_confirm"]],
  ["09:806", ["pending_confirm"], "ad.confirm", ["confirmed"]],
  ["09:807", ["pending_confirm", "confirmed"], "ad.request_revision", ["revising"]],
  ["09:808", ["pending_assign", "returned"], "ad.cancel", ["cancelled"]],
  ["09:809", ["producing", "revising", "pending_confirm", "returned"], "ad.cancel", ["cancelled"]],
]);
