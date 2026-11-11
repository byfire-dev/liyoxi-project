import { readQueueSearch } from "../../../lib/queue";
import { isId, checkedBody } from "../patrol/model";
import { PublishFailure, type Template } from "../patrol/api";
import type { CheckBody, BatchBody, OfflineDetail, OfflineScope } from "./api";
export const OFFLINE_KEY = ["publish", "offline"] as const;
export function offlineSearch(raw: Readonly<Record<string, unknown>>) {
  const search = readQueueSearch(raw),
    text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : undefined);
  return {
    ...search,
    q: search.q?.slice(0, 64),
    id: isId(search.id) ? search.id : undefined,
    tab: search.tab === "waiting" || search.tab === "checked" ? search.tab : "pending",
    isOverdue: text("isOverdue") === "true" ? "true" : undefined,
    basis: ["live", "delivered_unverified"].includes(text("basis") ?? "")
      ? (text("basis") as "live" | "delivered_unverified")
      : undefined,
    storeId: isId(raw.storeId) ? raw.storeId : undefined,
    orderItemId: isId(raw.orderItemId) ? raw.orderItemId : undefined,
    dueFrom: /^\d{4}-\d{2}-\d{2}$/.test(text("dueFrom") ?? "") ? text("dueFrom") : undefined,
    dueTo: /^\d{4}-\d{2}-\d{2}$/.test(text("dueTo") ?? "") ? text("dueTo") : undefined,
  };
}
export function offlineScope(search: ReturnType<typeof offlineSearch>): OfflineScope {
  return {
    q: search.q,
    isOverdue: search.isOverdue as "true" | undefined,
    basis: search.basis,
    storeId: search.storeId,
    orderItemId: search.orderItemId,
    dueFrom: search.dueFrom,
    dueTo: search.dueTo,
  };
}
export function checkBody(
  detail: Pick<OfflineDetail, "expectedChecklistCode" | "actions">,
  template: Template | undefined,
  checked: readonly string[],
  evidence: readonly string[],
): CheckBody | null {
  const body = checkedBody(template, checked, evidence, 2);
  return body && template?.code === detail.expectedChecklistCode && detail.actions.includes("check")
    ? { ...body, checklistCode: detail.expectedChecklistCode }
    : null;
}
export function batchBody(
  ids: readonly string[],
  entries: Readonly<Record<string, CheckBody | null>>,
): BatchBody | null {
  if (
    !ids.length ||
    ids.length > 50 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !entries[id])
  )
    return null;
  return { items: ids.map((takedownTaskId) => ({ takedownTaskId, ...entries[takedownTaskId]! })) };
}
export function batchRejections(
  cause: unknown,
): { index: number; takedownTaskId: string; error: string; message: string }[] {
  if (
    !(cause instanceof PublishFailure) ||
    cause.code !== "TAKEDOWN_BATCH_REJECTED" ||
    !cause.details ||
    typeof cause.details !== "object" ||
    !("items" in cause.details) ||
    !Array.isArray(cause.details.items)
  )
    return [];
  return cause.details.items.flatMap((item) =>
    item &&
    typeof item === "object" &&
    "index" in item &&
    typeof item.index === "number" &&
    "takedownTaskId" in item &&
    typeof item.takedownTaskId === "string" &&
    "error" in item &&
    typeof item.error === "string" &&
    "message" in item &&
    typeof item.message === "string"
      ? [
          {
            index: item.index,
            takedownTaskId: item.takedownTaskId,
            error: item.error,
            message: item.message,
          },
        ]
      : [],
  );
}
export const actionLabels = {
  check: "核查通过",
  "mark-online": "抽查仍在线",
  escalate: "逾期升级",
  "send-breach-notice": "发送违约提醒",
} as const;
export type OfflineAction = keyof typeof actionLabels;
