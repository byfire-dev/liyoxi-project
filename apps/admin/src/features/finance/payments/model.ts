import { DateSchema, IdSchema } from "@liyoxi/contract";
import { formatMoneyFixed } from "@liyoxi/shared/format/money";
import type { AccessSnapshot } from "../../../lib/permissions";
import { readTableSearch, type TableSearch } from "../../../lib/table-search";

export function choice<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return values.find((item) => item === value);
}
export const keyword = (value: unknown) =>
  typeof value === "string" ? value.trim().slice(0, 100) || undefined : undefined;
export const idValue = (value: unknown) =>
  IdSchema.safeParse(value).success ? String(value) : undefined;
export const dateValue = (value: unknown) =>
  DateSchema.safeParse(value).success ? String(value) : undefined;
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
export const channelLabel = (value: string | null) =>
  value === "wechat_jsapi" ? "微信支付" : value === "bank_transfer" ? "对公转账" : "—";
const orderTypes: Readonly<Record<string, string>> = {
  plan_new: "新购套餐",
  plan_renew: "续费套餐",
  plan_upgrade: "升级套餐",
  topup: "积分加购",
};
const reconStates: Readonly<Record<string, string>> = {
  pending: "待对账",
  matched: "已匹配",
  diff: "有差异",
  resolved: "差异已处理",
};
export const orderTypeLabel = (value: string) => orderTypes[value] ?? "其他类型";
export const reconLabel = (value: string) => reconStates[value] ?? "未知对账状态";
export function paymentSearch(raw: Record<string, unknown>) {
  const paging = readTableSearch(raw);
  return {
    page: paging.page,
    pageSize: paging.pageSize,
    q: keyword(raw.q),
    successFrom: dateValue(raw.successFrom),
    successTo: dateValue(raw.successTo),
    orderType: choice(raw.orderType, ["plan_new", "plan_renew", "plan_upgrade", "topup"] as const),
    channel: choice(raw.channel, ["wechat_jsapi", "bank_transfer"] as const),
    reconState: choice(raw.reconState, ["pending", "matched", "diff", "resolved"] as const),
    isApplied: choice(raw.isApplied, ["true", "false"] as const),
  };
}
export function paymentFilters(search: ReturnType<typeof paymentSearch>) {
  return {
    q: search.q,
    successFrom: search.successFrom,
    successTo: search.successTo,
    orderType: search.orderType,
    channel: search.channel,
    reconState: search.reconState,
    isApplied: search.isApplied,
  };
}
export function paymentTableSearch(search: ReturnType<typeof paymentSearch>): TableSearch {
  return readTableSearch(search, [
    "successFrom",
    "successTo",
    "orderType",
    "channel",
    "reconState",
    "isApplied",
  ]);
}
