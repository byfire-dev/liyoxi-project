import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { paramsAt } from "../config/index.js";

export function analyticsMonth(value: string): string {
  if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new AppError("VALIDATION_FAILED");
  return value;
}

export function currentAnalyticsMonth(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new AppError("VALIDATION_FAILED");
  return analyticsMonth(new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 7));
}

export function offsetAnalyticsMonth(month: string, offset: number): string {
  analyticsMonth(month);
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return analyticsMonth(date.toISOString().slice(0, 7));
}

/** 仅返回本模块固定表名；不得把 CLI 输入直接插进 SQL 标识符。 */
export function analyticsPartitionName(month: string): string {
  return `analytics_event_y${analyticsMonth(month).replace("-", "m")}`;
}

export async function analyticsRetention(tx: Tx, now: Date) {
  currentAnalyticsMonth(now);
  const values = await paramsAt(tx, ["analytics.retention_months"], now);
  const months = values["analytics.retention_months"];
  if (!Number.isInteger(months) || months < 13 || months > 60)
    throw new AppError("VALIDATION_FAILED");
  // 同退役能力的 PostgreSQL 月历减法；不以固定30天替代自然月。
  const rows = await tx.$queryRawUnsafe<Array<{ boundary: string }>>(
    "SELECT to_char(($1::timestamptz AT TIME ZONE 'Asia/Shanghai') - make_interval(months => $2::integer), 'YYYY-MM') AS boundary",
    now,
    months,
  );
  const boundary = rows[0]?.boundary;
  if (!boundary) throw new TypeError("analytics受限能力返回结果不合法");
  return { months, boundary: analyticsMonth(boundary) };
}
