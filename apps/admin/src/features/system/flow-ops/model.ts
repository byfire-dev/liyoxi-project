import {
  OutboxDeliveryListQuerySchema,
  TimerListQuerySchema,
  WebhookEventListQuerySchema,
} from "@liyoxi/contract/queries/admin";
import { readContractQuery } from "../../../lib/contract-query";
import { canAction, hasModuleLevel, type AccessSnapshot } from "../../../lib/permissions";
import { readTableSearch, type TableSearch } from "../../../lib/table-search";
import type {
  OutboxQuery,
  OutboxView,
  TimerQuery,
  TimerView,
  WebhookQuery,
  WebhookView,
} from "./api";
export const FLOW_KEY = ["system", "flow-ops"] as const;
export const TABS = [
  { key: "timers", label: "失败的定时器" },
  { key: "outbox", label: "死信投递" },
  { key: "webhooks", label: "回调收件箱" },
] as const;
export type FlowTab = (typeof TABS)[number]["key"];
export type FlowSearch = Record<string, string>;
const keys = {
  timers: [
    "status",
    "kind",
    "subjectType",
    "subjectId",
    "entityId",
    "fireFrom",
    "fireTo",
    "page",
    "pageSize",
  ],
  outbox: [
    "status",
    "subscriber",
    "eventType",
    "aggregateType",
    "aggregateId",
    "entityId",
    "page",
    "pageSize",
  ],
  webhooks: [
    "provider",
    "processState",
    "eventType",
    "receivedFrom",
    "receivedTo",
    "cursor",
    "limit",
  ],
} as const;
export function flowTab(search: Readonly<Record<string, unknown>>): FlowTab {
  return search.tab === "outbox" || search.tab === "webhooks" ? search.tab : "timers";
}
export function flowSearch(raw: Readonly<Record<string, unknown>>): FlowSearch {
  const tab = flowTab(raw),
    candidate = { ...raw };
  if (tab !== "webhooks" && ![10, 20, 50].includes(Number(candidate.pageSize)))
    delete candidate.pageSize;
  if (
    typeof candidate.cursor !== "string" ||
    candidate.cursor.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(candidate.cursor)
  )
    delete candidate.cursor;
  const pair = tab === "timers" ? ["subjectType", "subjectId"] : ["aggregateType", "aggregateId"];
  const from = tab === "timers" ? "fireFrom" : "receivedFrom",
    to = tab === "timers" ? "fireTo" : "receivedTo";
  if (
    typeof candidate[from] === "string" &&
    typeof candidate[to] === "string" &&
    candidate[from] > candidate[to]
  ) {
    delete candidate[from];
    delete candidate[to];
  }
  const options = { keys: keys[tab], recover: { [pair[0]!]: pair, [pair[1]!]: pair } };
  const wire =
    tab === "timers"
      ? readContractQuery(TimerListQuerySchema, candidate, {
          ...options,
          defaults: { status: "failed", page: "1", pageSize: "20" },
        }).wire
      : tab === "outbox"
        ? readContractQuery(OutboxDeliveryListQuerySchema, candidate, {
            ...options,
            defaults: { status: "dead", page: "1", pageSize: "20" },
          }).wire
        : readContractQuery(WebhookEventListQuerySchema, candidate, {
            ...options,
            defaults: { processState: "failed,dead", limit: "20" },
          }).wire;
  return { tab, ...wire };
}
export function changeFilter(
  search: FlowSearch,
  patch: Readonly<Record<string, string | undefined>>,
): FlowSearch {
  const next: Record<string, unknown> = { ...search, ...patch };
  delete next.page;
  delete next.cursor;
  return flowSearch(next);
}
export function timerQuery(search: FlowSearch): TimerQuery {
  const { tab: _tab, page, pageSize, ...wire } = flowSearch({ ...search, tab: "timers" });
  void _tab;
  return { ...wire, page: Number(page), pageSize: Number(pageSize) };
}
export function outboxQuery(search: FlowSearch): OutboxQuery {
  const { tab: _tab, page, pageSize, ...wire } = flowSearch({ ...search, tab: "outbox" });
  void _tab;
  return { ...wire, page: Number(page), pageSize: Number(pageSize) };
}
export function webhookQuery(search: FlowSearch): WebhookQuery {
  const { tab: _tab, limit, ...wire } = flowSearch({ ...search, tab: "webhooks" });
  void _tab;
  return { ...wire, limit: Number(limit) };
}
export function tableSearch(search: FlowSearch): TableSearch {
  return readTableSearch(search);
}
export function cursorScope(search: FlowSearch): string {
  const { cursor: _cursor, ...wire } = flowSearch(search);
  void _cursor;
  return JSON.stringify(Object.entries(wire).sort(([a], [b]) => a.localeCompare(b)));
}
export function canReadFlow(access: AccessSnapshot | null): boolean {
  return hasModuleLevel(access, "system") || canAction(access, "flow.ops.view");
}
export function actorKey(access: AccessSnapshot | null): string {
  return access
    ? `${access.staff.id}:${access.moduleLevels.system ?? "n"}:${canAction(access, "flow.ops.view")}:${canAction(access, "flow.ops.manage")}`
    : "anonymous";
}
export type FlowAction =
  | { kind: "reschedule"; row: TimerView }
  | { kind: "cancel"; row: TimerView }
  | { kind: "retry-outbox"; row: OutboxView }
  | { kind: "retry-webhook"; row: WebhookView };
export function actionAllowed(access: AccessSnapshot | null, action: FlowAction): boolean {
  if (!canAction(access, "flow.ops.manage")) return false;
  const actions: readonly string[] = action.row.actions;
  return actions.includes(
    action.kind === "reschedule" || action.kind === "cancel" ? action.kind : "retry",
  );
}
export function reasonValid(kind: FlowAction["kind"], text: string): boolean {
  const length = Array.from(text.trim()).length;
  return length <= 200 && (kind !== "cancel" || length >= 5);
}
const labels: Readonly<Record<string, string>> = {
  scheduled: "待触发",
  dispatched: "已派发",
  fired: "已触发",
  skipped: "已跳过",
  cancelled: "已取消",
  failed: "失败",
  pending: "待投递",
  leased: "已认领",
  done: "已完成",
  retry: "待重试",
  dead: "死信",
  received: "待处理",
  processed: "已处理",
  ignored: "已忽略",
};
export function statusLabel(status: string): string {
  return Object.hasOwn(labels, status) ? labels[status]! : "未知状态";
}
export function safeText(value: string | null | undefined, limit = 160): string {
  return value
    ? Array.from(value)
        .map((character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character,
        )
        .join("")
        .slice(0, limit)
    : "—";
}
const summaryLabels: Readonly<Record<string, string>> = {
  state: "状态",
  amountFen: "金额（分）",
  serial: "流水",
  tradeState: "交易状态",
  orderNo: "单号",
  processed: "处理条数",
  failed: "失败条数",
  count: "数量",
  skipped: "跳过条数",
  bytes: "字节数",
};
export function safeSummary(value: Record<string, unknown> | null): string {
  if (!value) return "—";
  const result = Object.entries(value)
    .slice(0, 12)
    .flatMap(([key, item]) =>
      Object.hasOwn(summaryLabels, key) &&
      ((typeof item === "number" && Number.isFinite(item)) ||
        (typeof item === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(item)))
        ? [`${summaryLabels[key]}：${String(item)}`]
        : [],
    );
  return result.length ? result.join(" · ") : "复杂内容已裁剪";
}
