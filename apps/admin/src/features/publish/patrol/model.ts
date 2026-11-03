import { readTableSearch, type TableSearch } from "../../../lib/table-search";
import type { NormalBody, AbnormalBody, PatrolQuery, PatrolScope, Template } from "./api";
export const PATROL_KEY = ["publish", "patrol"] as const;
export const isId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function patrolSearch(raw: Readonly<Record<string, unknown>>) {
  const search = readTableSearch(raw, ["weekStartDate", "openOnly", "source", "storeId"]);
  const filters = { ...search.filters };
  if (
    !filters.weekStartDate ||
    !/^\d{4}-\d{2}-\d{2}$/.test(filters.weekStartDate) ||
    new Date(`${filters.weekStartDate}T00:00:00Z`).getUTCDay() !== 1
  )
    delete filters.weekStartDate;
  if (!["true", "false"].includes(filters.openOnly ?? "")) delete filters.openOnly;
  if (!["weekly_sample", "manual", "reissue"].includes(filters.source ?? "")) delete filters.source;
  if (!isId(filters.storeId)) delete filters.storeId;
  return {
    ...search,
    q: search.q?.slice(0, 64),
    sort: undefined,
    filters,
    tab: ["pending", "abnormal", "normal"].includes(search.tab ?? "") ? search.tab! : "all",
    id: isId(raw.id) ? raw.id : undefined,
  };
}
export function patrolScope(search: TableSearch): PatrolScope {
  return {
    q: search.q,
    weekStartDate: search.filters.weekStartDate,
    openOnly: search.filters.openOnly as "true" | "false" | undefined,
    source: search.filters.source as "weekly_sample" | "manual" | "reissue" | undefined,
    storeId: search.filters.storeId,
  };
}
export function patrolQuery(search: TableSearch): PatrolQuery {
  return {
    ...patrolScope(search),
    tab: search.tab as "all" | "pending" | "abnormal" | "normal",
    page: search.page,
    pageSize: search.pageSize,
  };
}
export function checkedBody(
  template: Template | undefined,
  checked: readonly string[],
  evidence: readonly string[],
  minimum = 1,
): NormalBody | null {
  if (
    !template?.items.length ||
    template.items.some((item) => !checked.includes(item.key)) ||
    evidence.length < minimum ||
    evidence.length > 9 ||
    new Set(evidence).size !== evidence.length
  )
    return null;
  return {
    checklistVersionNo: template.versionNo,
    results: template.items.map((item) => ({ key: item.key, result: "pass" })),
    evidenceFileIds: [...evidence],
  };
}
export function abnormalBody(
  code: string,
  note: string,
  evidence: readonly string[],
): AbnormalBody | null {
  const text = note.trim();
  return code &&
    text &&
    text.length <= 200 &&
    evidence.length >= 1 &&
    evidence.length <= 9 &&
    new Set(evidence).size === evidence.length
    ? { abnormalKindCode: code, note: text, evidenceFileIds: [...evidence] }
    : null;
}
export const factChanged = (code?: string) =>
  [
    "VERSION_CONFLICT",
    "STATE_NOT_ALLOWED",
    "PRECONDITION_CHANGED",
    "CHECKLIST_VERSION_STALE",
    "CONFIRM_MISMATCH",
    "DICT_ITEM_DISABLED",
  ].includes(code ?? "");
