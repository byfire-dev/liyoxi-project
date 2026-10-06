import { DELIVERY_TICKET_STEP } from "@liyoxi/contract/enums";
import { newIdempotencyKey } from "../../../lib/idempotency";
import { readTableSearch, type TableSearch } from "../../../lib/table-search";
import type { TicketFilters, TicketQuery } from "./api";
export const TICKETS_KEY = ["delivery", "tickets"] as const;
export const ticketTabs = [
  "processing",
  ...DELIVERY_TICKET_STEP.values.filter((s) => s !== "archived" && s !== "terminated"),
  "closed",
  "delivered_today",
  "all",
] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function ticketSearch(raw: Readonly<Record<string, unknown>>): TableSearch {
  const search = readTableSearch(raw, [
      "deliveryManagerId",
      "productionModel",
      "platform",
      "overdueOnly",
    ]),
    filters = { ...search.filters };
  if (
    filters.deliveryManagerId &&
    filters.deliveryManagerId !== "none" &&
    !uuid.test(filters.deliveryManagerId)
  )
    delete filters.deliveryManagerId;
  if (!["standard", "advanced", "top"].includes(filters.productionModel ?? ""))
    delete filters.productionModel;
  if (!["douyin", "wechat_channels"].includes(filters.platform ?? "")) delete filters.platform;
  if (!["true", "false"].includes(filters.overdueOnly ?? "")) delete filters.overdueOnly;
  return {
    ...search,
    q: search.q?.slice(0, 40),
    filters,
    tab: ticketTabs.find((tab) => tab === search.tab) ?? "processing",
    sort: ["urgency", "-createdAt", "stepDueAt", "agreedLaunchDate"].includes(search.sort ?? "")
      ? search.sort
      : "urgency",
  };
}
export function ticketFilters(search: TableSearch): TicketFilters {
  return {
    q: search.q,
    deliveryManagerId: search.filters.deliveryManagerId,
    productionModel:
      search.filters.productionModel === "standard"
        ? "standard"
        : search.filters.productionModel === "advanced"
          ? "advanced"
          : search.filters.productionModel === "top"
            ? "top"
            : undefined,
    platform:
      search.filters.platform === "douyin"
        ? "douyin"
        : search.filters.platform === "wechat_channels"
          ? "wechat_channels"
          : undefined,
    overdueOnly: search.filters.overdueOnly === "true" ? "true" : undefined,
  };
}
export function ticketQuery(search: TableSearch): TicketQuery {
  return {
    ...ticketFilters(search),
    tab: ticketTabs.find((tab) => tab === search.tab) ?? "processing",
    page: search.page,
    pageSize: search.pageSize,
    sort:
      search.sort === "-createdAt"
        ? "-createdAt"
        : search.sort === "stepDueAt"
          ? "stepDueAt"
          : search.sort === "agreedLaunchDate"
            ? "agreedLaunchDate"
            : "urgency",
  };
}
/** 同一请求内容重试保留键；同步锁覆盖 React 按钮状态更新前的重复点击。 */
export function createAssignmentIntent(newKey = () => newIdempotencyKey("ticket-manager")) {
  let busy = false,
    fingerprint = "",
    key = "";
  return async <T>(payload: unknown, send: (key: string) => Promise<T>): Promise<T | null> => {
    if (busy) return null;
    const next = JSON.stringify(payload);
    if (next !== fingerprint) {
      fingerprint = next;
      key = newKey();
    }
    busy = true;
    try {
      return await send(key);
    } finally {
      busy = false;
    }
  };
}
