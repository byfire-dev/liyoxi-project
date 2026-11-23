// Existing finance helpers kept local to the preprod settings backport.
import { IdSchema } from "@liyoxi/contract";
import { formatMoneyFixed } from "@liyoxi/shared/format/money";
import type { QueryClient } from "@tanstack/react-query";
import type { AccessSnapshot } from "../../../lib/permissions";

export function choice<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return values.find((item) => item === value);
}
export const idValue = (value: unknown) =>
  IdSchema.safeParse(value).success ? String(value) : undefined;
export function financeScope(access: AccessSnapshot | null) {
  return JSON.stringify(access);
}
/** 汇总为 bigint 十进制字符串；仅按位排版，不经浮点或 Number。 */
export function moneyText(value: number | string | null | undefined): string {
  if (value == null) return "—";
  if (typeof value === "number") return formatMoneyFixed(value);
  if (!/^-?\d+$/.test(value)) return "—";
  const negative = value.startsWith("-"),
    digits = value
      .replace(/^-/, "")
      .replace(/^0+(?=\d)/, "")
      .padStart(3, "0"),
    whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative && /[1-9]/.test(digits) ? "−" : ""}¥${whole}.${digits.slice(-2)}`;
}
/** 先撤销同key旧读取；迟到的写前GET不能覆盖这次真实重读，scope/id卸载信号禁止发布。 */
export async function refreshAdjustmentDetail<T>(
  cache: QueryClient,
  queryKey: readonly unknown[],
  signal: AbortSignal,
  read: (signal: AbortSignal) => Promise<T>,
) {
  signal.throwIfAborted();
  await cache.cancelQueries({ queryKey, exact: true });
  signal.throwIfAborted();
  const value = await read(signal);
  signal.throwIfAborted();
  cache.setQueryData(queryKey, value);
  return value;
}
