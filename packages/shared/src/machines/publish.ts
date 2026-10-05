// publish 模块：渠道账号、上线任务、巡检任务、下架任务的状态迁移表。
// 每行：分组文档的行（分组:行号）、当前状态（null 是新建）、迁移事件码、新状态（SAME 是不改状态）；文档没写守卫的行尾是 NO_GUARD。
// 改这里的行，要在同一个 PR 改分组文档的那一行：pnpm machines:check 逐行对照。
import {
  CHANNEL_ACCOUNT_STATUS,
  LAUNCH_TASK_REVIEW_STATUS,
  PATROL_TASK_STATUS,
  TAKEDOWN_TASK_STATUS,
} from "@liyoxi/contract/enums";

import { NO_GUARD, SAME, chain } from "./define.js";

/** channel_account.status：docs/data-model/11-publish.md */
export const channelAccount = chain("channel_account", "status", CHANNEL_ACCOUNT_STATUS, [
  ["11:129", null, "account.bind", ["pending_verify"]],
  ["11:130", ["pending_verify"], "account.verify_pass", ["available"]],
  ["11:131", ["pending_verify"], "account.verify_reject", ["abnormal"]],
  ["11:132", ["abnormal"], "account.resubmit", ["pending_verify"]],
  ["11:133", ["available"], "account.mark_abnormal", ["abnormal"]],
  ["11:134", ["pending_verify", "available", "abnormal"], "account.unbind", ["unbound"]],
]);

/** launch_task.review_status：docs/data-model/11-publish.md */
export const launchTask = chain("launch_task", "review_status", LAUNCH_TASK_REVIEW_STATUS, [
  ["11:299", null, "launch.create", ["pending"]],
  ["11:300", ["pending", "need_fix", "passed"], "launch.submit", ["verifying"]],
  ["11:301", ["verifying"], "launch.verify_pass", ["passed"]],
  ["11:302", ["verifying"], "launch.return", ["need_fix"]],
  ["11:303", ["passed"], "launch.verify_revoke", ["verifying"]],
  ["11:304", ["pending", "need_fix", "verifying", "passed"], "launch.void", ["void"]],
  ["11:305", ["verifying", "need_fix"], "launch.settle", ["passed"]],
]);

/** patrol_task.status：docs/data-model/11-publish.md */
export const patrolTask = chain("patrol_task", "status", PATROL_TASK_STATUS, [
  ["11:542", null, "patrol.create", ["pending"]],
  ["11:543", ["pending"], "patrol.ok", ["normal"]],
  ["11:544", ["pending"], "patrol.abnormal", ["abnormal"]],
  ["11:545", ["abnormal"], "patrol.remind", ["abnormal"]],
  ["11:546", ["abnormal"], "patrol.recover", ["recovered"]],
  ["11:547", ["pending", "abnormal"], "patrol.void", ["void"]],
]);

/** takedown_task.status：docs/data-model/11-publish.md */
export const takedownTask = chain("takedown_task", "status", TAKEDOWN_TASK_STATUS, [
  ["11:653", null, "takedown.create", ["pending_merchant"]],
  ["11:654", ["pending_merchant"], "takedown.merchant_confirm", ["merchant_confirmed"]],
  ["11:655", ["merchant_confirmed", "pending_merchant"], "takedown.check_pass", ["checked"]],
  ["11:656", ["merchant_confirmed"], "takedown.sample_release", ["checked"]],
  ["11:657", ["merchant_confirmed"], "takedown.still_online", ["pending_merchant"], NO_GUARD],
  ["11:658", ["merchant_confirmed"], "takedown.basis_reopen", ["pending_merchant"]],
  ["11:659", ["pending_merchant"], "takedown.escalate", SAME, NO_GUARD],
  ["11:660", ["pending_merchant"], "takedown.breach_notice", SAME],
  ["11:661", ["pending_merchant"], "takedown.void", ["void"]],
]);
