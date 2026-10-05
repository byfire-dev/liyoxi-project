// 账务推进循环 billing_advance（W1-10）。依据：x01 第 4.3 节“账务推进 advance”行；D1 第 6.2 节。
// 每分钟一轮：next_due_at 已到的主体逐个 FOR UPDATE SKIP LOCKED 后 advance（发放、清零、预约周期接续、过期停用）。
// 写操作开头也会 advance，这里是兜底：没有账本写操作的主体靠它按时发放与清零。只依赖 PostgreSQL，Redis 不可用时照跑。
// 用例函数在 @liyoxi/services 的 billing（advanceDueAccounts），这里只有节奏。
import type { DomainLoopDef } from "../loop.js";

export const billingAdvance: DomainLoopDef = {
  name: "billing_advance",
  intervalMs: 60_000,
  run: (services, beat) => services.advanceBilling({ beat }),
};
