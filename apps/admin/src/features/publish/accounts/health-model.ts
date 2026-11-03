import { readTableSearch, writeTableSearch, type TableSearch } from "../../../lib/table-search";
import { writeQueueSearch } from "../../../lib/queue";
import { isId } from "../patrol/model";
import { accountSearch } from "./model";
import type { HealthQuery, HealthScope } from "./health-api";
export const HEALTH_KEY = ["publish", "account-health"] as const;
export function healthSearch(raw: Readonly<Record<string, unknown>>) {
  const search = readTableSearch(
    {
      tab: raw.healthTab,
      q: raw.healthQ,
      page: raw.healthPage,
      pageSize: raw.healthPageSize,
      platform: raw.healthPlatform,
      storeId: raw.healthStoreId,
    },
    ["platform", "storeId"],
  );
  const filters = { ...search.filters };
  if (!["douyin", "wechat_channels"].includes(filters.platform ?? "")) delete filters.platform;
  if (!isId(filters.storeId)) delete filters.storeId;
  return {
    ...search,
    filters,
    q: search.q?.slice(0, 64),
    tab: ["pending_verify", "available", "abnormal", "unbound"].includes(search.tab ?? "")
      ? search.tab
      : "all",
    id: isId(raw.healthId) ? raw.healthId : undefined,
  };
}
export function writeHealthSearch(search: TableSearch, id?: string) {
  const raw = writeTableSearch(search);
  return {
    view: "health",
    healthTab: raw.tab,
    healthQ: raw.q,
    healthPage: raw.page,
    healthPageSize: raw.pageSize,
    healthPlatform: raw.platform,
    healthStoreId: raw.storeId,
    healthId: id,
  };
}
export function accountRouteSearch(raw: Readonly<Record<string, unknown>>) {
  return {
    ...writeQueueSearch(accountSearch(raw)),
    ...(raw.view === "health" ? writeHealthSearch(healthSearch(raw), healthSearch(raw).id) : {}),
  };
}
export function healthScope(search: TableSearch): HealthScope {
  return {
    q: search.q,
    platform: search.filters.platform as "douyin" | "wechat_channels" | undefined,
    storeId: search.filters.storeId,
  };
}
export function healthQuery(search: TableSearch): HealthQuery {
  return {
    ...healthScope(search),
    status: search.tab === "all" ? undefined : search.tab,
    page: search.page,
    pageSize: search.pageSize,
  };
}
export function healthAbnormalBody(reasonCode: string, note: string) {
  const text = note.trim();
  return reasonCode && text && text.length <= 200 ? { reasonCode, note: text } : null;
}
