import type { Tx } from "../kernel/index.js";
/** 8 天留存；有界清理，允许并行实例跳过已认领行，不触碰埋点原始分区。 */
export async function purgeAnalyticsDedup(tx: Tx, now: Date, limit = 5_000): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50_000)
    throw new TypeError("去重清理批量须为1–50000");
  const before = new Date(now.getTime() - 8 * 86_400_000);
  return tx.$executeRaw`WITH old AS (SELECT event_id FROM analytics_event_dedup WHERE received_at < ${before}::timestamptz ORDER BY received_at, event_id LIMIT ${limit} FOR UPDATE SKIP LOCKED) DELETE FROM analytics_event_dedup d USING old WHERE d.event_id = old.event_id`;
}
