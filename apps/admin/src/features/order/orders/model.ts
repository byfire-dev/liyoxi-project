import { isLocalDate } from "@liyoxi/shared/time";
import { DRAMA_ORDER_STATUS } from "@liyoxi/contract/enums";
import { readTableSearch, type TableSearch } from "../../../lib/table-search";
import type { OrderCard, OrderFilters, OrderQuery } from "./api";
export const ORDERS_KEY = ["order", "orders"] as const;
export const orderTabs = ["all", ...DRAMA_ORDER_STATUS.values] as const;
export const models: Record<string, string> = {
  standard: "标准模型",
  advanced: "高级模型",
  top: "顶级模型",
};
export const platforms: Record<string, string> = { douyin: "抖音", wechat_channels: "视频号" };
export const subStatuses: Record<string, string> = {
  qualification_reviewing: "资质审核中",
  qualification_rejected: "资质已驳回",
  starting: "准备开工",
  assigning: "工单待分配",
  plan_confirm: "方案确认",
  ad_preparing: "广告准备",
  sample_making: "样片制作",
  sample_confirm: "样片确认",
  episode_producing: "批量合成",
  delivering: "成片交付",
  awaiting_links: "等待商家上线",
  verifying: "上线核验",
  need_fix: "待补充上线资料",
  in_service: "服务中",
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function orderSearch(raw: Readonly<Record<string, unknown>>): TableSearch {
  const search = readTableSearch(raw, [
    "deliveryManagerId",
    "dramaId",
    "submittedFrom",
    "submittedTo",
    "isRejectedStale",
  ]);
  const filters = { ...search.filters };
  for (const key of ["deliveryManagerId", "dramaId"])
    if (
      filters[key] &&
      !uuid.test(filters[key]!) &&
      !(key === "deliveryManagerId" && filters[key] === "none")
    )
      delete filters[key];
  for (const key of ["submittedFrom", "submittedTo"])
    if (filters[key] && !isLocalDate(filters[key]!)) delete filters[key];
  if (filters.submittedFrom && filters.submittedTo && filters.submittedFrom > filters.submittedTo) {
    delete filters.submittedFrom;
    delete filters.submittedTo;
  }
  if (!["true", "false"].includes(filters.isRejectedStale ?? "")) delete filters.isRejectedStale;
  return {
    ...search,
    q: search.q?.slice(0, 40),
    filters,
    tab: orderTabs.find((tab) => tab === search.tab) ?? "all",
    sort: ["-submittedAt", "submittedAt", "-statusChangedAt"].includes(search.sort ?? "")
      ? search.sort
      : "-submittedAt",
  };
}
export function orderFilters(search: TableSearch): OrderFilters {
  const { deliveryManagerId, dramaId, submittedFrom, submittedTo } = search.filters;
  return {
    q: search.q,
    deliveryManagerId,
    dramaId,
    submittedFrom,
    submittedTo,
    isRejectedStale: search.filters.isRejectedStale === "true" ? "true" : undefined,
  };
}
export function orderQuery(search: TableSearch): OrderQuery {
  return {
    ...orderFilters(search),
    page: search.page,
    pageSize: search.pageSize,
    tab: orderTabs.find((tab) => tab === search.tab) ?? "all",
    sort:
      search.sort === "submittedAt"
        ? "submittedAt"
        : search.sort === "-statusChangedAt"
          ? "-statusChangedAt"
          : "-submittedAt",
  };
}
/** 单号直开与刷新只按正式 q 查找，并严格匹配；不能把单号猜作UUID或采用近似命中。 */
export async function resolveOrderNo(
  api: {
    list(query: OrderQuery): Promise<{ items: readonly Pick<OrderCard, "orderId" | "orderNo">[] }>;
  },
  orderNo: string,
): Promise<string | null> {
  if (!orderNo || orderNo.length > 40) return null;
  const list = await api.list({ q: orderNo, tab: "all", page: 1, pageSize: 100 });
  return list.items.find((item) => item.orderNo === orderNo)?.orderId ?? null;
}

export function historyOrderId(state: unknown, orderNo: string): string | undefined {
  if (typeof state !== "object" || state === null || !("lyxOrder" in state)) return undefined;
  const entry = state.lyxOrder;
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("orderNo" in entry) ||
    entry.orderNo !== orderNo ||
    !("orderId" in entry) ||
    typeof entry.orderId !== "string" ||
    !uuid.test(entry.orderId)
  )
    return undefined;
  return entry.orderId;
}
