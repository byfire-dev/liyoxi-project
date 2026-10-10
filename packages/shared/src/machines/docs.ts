// docs 模块：授权书的状态迁移表。
// 每行：分组文档的行（分组:行号）、当前状态（null 是新建）、迁移事件码、新状态（SAME 是不改状态）；文档没写守卫的行尾是 NO_GUARD。
// 改这里的行，要在同一个 PR 改分组文档的那一行：pnpm machines:check 逐行对照。
import { LICENSE_LETTER_STATUS } from "@liyoxi/contract/enums";

import { chain } from "./define.js";

/** license_letter.status：docs/data-model/13-notify-docs.md */
export const licenseLetter = chain("license_letter", "status", LICENSE_LETTER_STATUS, [
  ["13:942", null, "license_letter.create", ["pending_effective", "effective"]],
  ["13:944", ["pending_effective"], "license_letter.go_live", ["effective"]],
  ["13:946", ["effective"], "license_letter.revoke_live", ["pending_effective"]],
  ["13:947", ["pending_effective", "effective"], "license_letter.void", ["voided"]],
  ["13:948", ["pending_effective", "effective"], "license_letter.void", ["voided"]],
  ["13:949", ["pending_effective", "effective"], "license_letter.void", ["voided"]],
]);
