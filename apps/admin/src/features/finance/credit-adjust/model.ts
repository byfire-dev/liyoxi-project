import type { QueryClient } from "@tanstack/react-query";
import { newIdempotencyKey } from "../../../lib/idempotency";
import { canAction, hasModuleLevel, type AccessSnapshot } from "../../../lib/permissions";
import { readTableSearch } from "../../../lib/table-search";
import { choice, dateValue, idValue } from "../payments/model";
import type { AdjustmentCase, AdjustmentKind, Decision } from "./types";

export type { AdjustmentKind, Decision } from "./types";

export const kindLabels = { points_adjust: "积分调整", subscription_extend: "补偿延长" } as const;
export const decisionLabels = { approve: "通过", reject: "驳回", withdraw: "撤回" } as const;
export const statusLabels = {
  pending: "待处理",
  approved: "已通过",
  rejected: "已驳回",
  withdrawn: "已撤回",
} as const;
export const tabLabels = {
  todo: "待我处理",
  submitted: "我提交的",
  done_today: "今日已处理",
  all: "全部",
} as const;
const kinds = ["points_adjust", "subscription_extend"] as const;
export function readableKinds(access: AccessSnapshot | null): AdjustmentKind[] {
  // 与当前已合审批kind的viewModules一致；不额外授予groupBound或审批权限。
  return kinds.filter((kind) =>
    kind === "points_adjust"
      ? hasModuleLevel(access, "billing") || hasModuleLevel(access, "finance")
      : hasModuleLevel(access, "billing") || hasModuleLevel(access, "order"),
  );
}
export function adjustmentSearch(raw: Record<string, unknown>) {
  const paging = readTableSearch(raw);
  return {
    page: paging.page,
    pageSize: paging.pageSize,
    tab: choice(raw.tab, ["todo", "submitted", "done_today", "all"] as const) ?? "todo",
    kind: choice(raw.kind, kinds),
    status: choice(raw.status, ["pending", "approved", "rejected", "withdrawn"] as const),
    overdue: choice(raw.overdue, ["true", "false"] as const),
    q: typeof raw.q === "string" ? raw.q.trim().slice(0, 30) || undefined : undefined,
    submittedFrom: dateValue(raw.submittedFrom),
    submittedTo: dateValue(raw.submittedTo),
    entityId: idValue(raw.entityId),
    storeId: idValue(raw.storeId),
    id: idValue(raw.id),
    sort: choice(raw.sort, ["due", "-submittedAt", "-decidedAt"] as const),
  };
}
export function adjustmentView(
  search: ReturnType<typeof adjustmentSearch>,
  allowed: readonly AdjustmentKind[],
) {
  const invalidRange =
      !!search.submittedFrom && !!search.submittedTo && search.submittedFrom > search.submittedTo,
    denied = allowed.length === 0 || (!!search.kind && !allowed.includes(search.kind)),
    enabled = !denied && !invalidRange;
  return { invalidRange, denied, enabled, selectedId: enabled ? search.id : undefined };
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
export function adjustmentFilters(
  search: ReturnType<typeof adjustmentSearch>,
  allowed: readonly AdjustmentKind[],
) {
  return {
    kind: search.kind ?? allowed.join(","),
    q: search.q,
    status: search.status,
    overdue: search.overdue,
    submittedFrom: search.submittedFrom,
    submittedTo: search.submittedTo,
    entityId: search.entityId,
    storeId: search.storeId,
  };
}
export function adjustmentTable(search: ReturnType<typeof adjustmentSearch>) {
  return readTableSearch(search, [
    "kind",
    "status",
    "overdue",
    "submittedFrom",
    "submittedTo",
    "entityId",
    "storeId",
  ]);
}
export function allowedDecisions(value: AdjustmentCase, access: AccessSnapshot | null): Decision[] {
  if (!access || value.row.approval.status !== "pending") return [];
  const permission =
    value.kind === "points_adjust" ? "billing.adjust.approve" : "billing.extension.approve";
  return value.row.actions.filter(
    (action) =>
      value.row.approval.actions.includes(action) &&
      (action === "withdraw" ||
        (canAction(access, permission) &&
          value.row.approval.requester?.staffId !== access.staff.id)),
  );
}
export function approveReady(value: AdjustmentCase) {
  return (
    value.row.requestNo !== null &&
    (value.kind === "points_adjust" ||
      (value.row.preview !== null &&
        value.row.preview.mode !== "not_applicable" &&
        value.row.preview.blockReasons.length === 0))
  );
}
/** 单选中项三种意图：同正文失败保留key；同步闩挡双击；卸载取消且丢弃迟到结果。 */
export function createDecisionIntent(makeKey = () => newIdempotencyKey("billing-approval")) {
  const keys = new Map<Decision, { signature: string; key: string }>();
  let busy = false,
    active = true,
    generation = 0,
    controller = new AbortController();
  return {
    get pending() {
      return busy;
    },
    activate() {
      if (!active) {
        active = true;
        controller = new AbortController();
      }
    },
    close() {
      active = false;
      generation += 1;
      busy = false;
      controller.abort();
    },
    async submit<T>(
      action: Decision,
      fingerprint: unknown,
      send: (key: string, signal: AbortSignal) => Promise<T>,
    ) {
      if (!active || busy) return undefined;
      const signature = JSON.stringify(fingerprint),
        old = keys.get(action),
        intent = old?.signature === signature ? old : { signature, key: makeKey() };
      keys.set(action, intent);
      busy = true;
      const own = generation,
        signal = controller.signal;
      try {
        const result = await send(intent.key, signal);
        if (!active || signal.aborted || own !== generation) return undefined;
        keys.delete(action);
        return result;
      } catch (error) {
        if (active && !signal.aborted && own === generation) throw error;
        return undefined;
      } finally {
        if (own === generation) busy = false;
      }
    },
  };
}
