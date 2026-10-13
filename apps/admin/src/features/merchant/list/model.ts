import { StoreListQuerySchema } from "@liyoxi/contract";
import { readContractQuery } from "../../../lib/contract-query";
import type { Query } from "../detail/api";
export const STORE_KEYS = [
  "q",
  "regionCode",
  "industryCode",
  "categoryCode",
  "qualificationStatus",
  "sourceType",
  "subscriptionStatus",
  "planId",
  "expiresWithinDays",
  "deliveryManagerId",
  "isManagerUnassigned",
  "entityId",
  "lifecycle",
  "page",
  "pageSize",
  "sort",
] as const;
export function merchantListSearch(raw: Readonly<Record<string, unknown>>): Record<string, string> {
  const input = { ...raw };
  if (![10, 20, 50].includes(Number(input.pageSize))) delete input.pageSize;
  if (
    input.deliveryManagerId &&
    (input.isManagerUnassigned === "true" || input.isManagerUnassigned === true)
  )
    delete input.isManagerUnassigned;
  return readContractQuery(StoreListQuerySchema, input, {
    keys: STORE_KEYS,
    defaults: { lifecycle: "active", sort: "-lastOrderAt", page: "1", pageSize: "20" },
    keywordLimit: 30,
  }).wire;
}
export function merchantListQuery(
  raw: Readonly<Record<string, unknown>>,
): Query<"admin.store.list"> {
  const { page, pageSize, ...wire } = merchantListSearch(raw);
  return { ...wire, page: Number(page), pageSize: Number(pageSize) };
}
export function merchantSummaryQuery(
  raw: Readonly<Record<string, unknown>>,
): Query<"admin.store.summary"> {
  const { page: _page, pageSize: _size, sort: _sort, ...wire } = merchantListSearch(raw);
  void _page;
  void _size;
  void _sort;
  return wire;
}
