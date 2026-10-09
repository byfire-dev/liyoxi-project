import type { Assembly, Clock, RecurringRunContext } from "../kernel/index.js";
import { purgeAnalyticsDedup } from "./dedup-purge.js";
import { createAnalyticsPartitions } from "./partitions.js";
import type { AnalyticsPartitionsDeps } from "./partitions.js";
import { assertAnalyticsActive } from "./partition-archive.js";
/** job模式：实际执行时刻固定cutoff，每5000行单独短TX，既有执行器续租/中止。 */
async function purge(
  clock: Clock,
  ctx: RecurringRunContext,
): Promise<Readonly<Record<string, unknown>>> {
  if (!ctx.runTx) throw new Error("analytics.dedup_purge必须登记job模式");
  const now = clock.now();
  let deleted = 0,
    batches = 0;
  for (;;) {
    assertAnalyticsActive(ctx.signal);
    const count = await ctx.runTx((tx) => purgeAnalyticsDedup(tx, now));
    deleted += count;
    batches++;
    if (count < 5_000) return { deleted, batches };
  }
}

/** 原登记仅保留元数据；组合根为本次装配复制两个闭包，不建立全局绑定。 */
export async function runScheduledDedupPurge(): Promise<never> {
  throw new Error("analytics.dedup_purge尚未绑定运行时时钟");
}
export async function runScheduledPartitions(): Promise<never> {
  throw new Error("analytics.partitions尚未绑定运行时");
}
export function createAnalyticsJobs(base: Assembly, deps: AnalyticsPartitionsDeps) {
  const controller = new AbortController(),
    pending = new Set<Promise<unknown>>();
  const partitions = createAnalyticsPartitions(deps);
  let closed = false,
    closing: Promise<void> | undefined;
  const tracked = <T>(
    run: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    if (closed) return Promise.reject(new Error("analytics运行时已经关闭"));
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const task = run(combined);
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  const recurringJobs = base.recurringJobs.map((item) =>
    item.kind === "analytics.dedup_purge" || item.kind === "analytics.partitions"
      ? {
          ...item,
          run: (ctx: RecurringRunContext) =>
            tracked(
              (signal) =>
                item.kind === "analytics.dedup_purge"
                  ? purge(deps.clock, { ...ctx, signal })
                  : partitions.maintain({ ...ctx, signal }),
              ctx.signal,
            ),
        }
      : item,
  );
  const index = new Map(recurringJobs.map((item) => [item.kind, item]));
  const assembly: Assembly = { ...base, recurringJobs, recurringJob: (kind) => index.get(kind) };
  return {
    assembly,
    repartition: (input: Parameters<typeof partitions.repartition>[0], signal?: AbortSignal) =>
      tracked((combined) => partitions.repartition(input, combined), signal),
    close(): Promise<void> {
      if (!closing) {
        closed = true;
        controller.abort();
        closing = Promise.allSettled([...pending]).then(() => undefined);
      }
      return closing;
    },
  };
}
export type AnalyticsJobs = ReturnType<typeof createAnalyticsJobs>;
