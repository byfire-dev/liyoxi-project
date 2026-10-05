// content 模块：短剧的状态迁移表。
// 每行：分组文档的行（分组:行号）、当前状态（null 是新建）、迁移事件码、新状态（SAME 是不改状态）；文档没写守卫的行尾是 NO_GUARD。
// 改这里的行，要在同一个 PR 改分组文档的那一行：pnpm machines:check 逐行对照。
import { DRAMA_STATUS } from "@liyoxi/contract/enums";

import { NO_GUARD, chain } from "./define.js";

/** drama.status：docs/data-model/05-content.md */
export const drama = chain("drama", "status", DRAMA_STATUS, [
  ["05:143", null, "drama.create", ["draft"], NO_GUARD],
  ["05:144", ["draft"], "drama.list", ["listed"]],
  ["05:145", ["listed"], "drama.delist", ["delisted"]],
  ["05:146", ["listed"], "drama.license_expire", ["delisted"]],
  ["05:147", ["delisted"], "drama.relist", ["listed"]],
]);
