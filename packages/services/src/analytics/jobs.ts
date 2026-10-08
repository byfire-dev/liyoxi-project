import type { Clock, RecurringRunContext } from "../kernel/index.js";
import { purgeAnalyticsDedup } from "./dedup-purge.js";

let current: { readonly clock: Clock } | undefined;
/** 每个进程装配一次，解绑只删除自己，避免旧runtime关闭新绑定。 */
export function bindAnalytics(binding: { readonly clock: Clock }): () => void {
  current = binding;
  return () => {
    if (current === binding) current = undefined;
  };
}
/** job模式：实际执行时刻固定cutoff，每5000行单独短TX，既有执行器续租/中止。 */
export async function runScheduledDedupPurge(
  ctx: RecurringRunContext,
): Promise<Readonly<Record<string, unknown>>> {
  if (!current) throw new Error("analytics.dedup_purge尚未绑定运行时时钟");
  if (!ctx.runTx) throw new Error("analytics.dedup_purge必须登记job模式");
  const now = current.clock.now();
  let deleted = 0,
    batches = 0;
  for (;;) {
    if (ctx.signal?.aborted) throw new Error("analytics.dedup_purge已取消");
    const count = await ctx.runTx((tx) => purgeAnalyticsDedup(tx, now));
    deleted += count;
    batches++;
    if (count < 5_000) return { deleted, batches };
  }
}
