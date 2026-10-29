import { IdSchema, ReconciliationMonthQuerySchema } from "@liyoxi/contract";
import type { PaymentExceptionResolveBody } from "@liyoxi/contract";
import type { AccessSnapshot } from "../../../lib/permissions";
import { canAction, hasModuleLevel } from "../../../lib/permissions";
import { newIdempotencyKey } from "../../../lib/idempotency";
import { readTableSearch } from "../../../lib/table-search";
import { choice, dateValue, idValue, keyword } from "../payments/model";
import { kindLabels } from "./labels";
import type { QueryClient } from "@tanstack/react-query";
import type { ExceptionDetail, ReconCommand } from "./types";

export function reconcileSearch(raw: Record<string, unknown>) {
  const table = readTableSearch(raw);
  return {
    month: ReconciliationMonthQuerySchema.safeParse({ month: raw.month }).success
      ? String(raw.month)
      : undefined,
    tab: choice(raw.tab, ["open", "resolving", "resolved", "all"] as const) ?? "open",
    kind: choice(raw.kind, Object.keys(kindLabels) as (keyof typeof kindLabels)[]),
    billDateFrom: dateValue(raw.billDateFrom),
    billDateTo: dateValue(raw.billDateTo),
    q: keyword(raw.q),
    page: table.page,
    pageSize: table.pageSize,
    paymentExceptionId: idValue(raw.paymentExceptionId),
  };
}
export function exceptionQuery(search: ReturnType<typeof reconcileSearch>) {
  return {
    tab: search.tab,
    q: search.q,
    kind: search.kind ? [search.kind] : undefined,
    billDateFrom: search.billDateFrom,
    billDateTo: search.billDateTo,
    page: search.page,
    pageSize: search.pageSize,
  };
}
export const canReconcile = (access: AccessSnapshot | null) =>
  hasModuleLevel(access, "finance") && canAction(access, "finance.recon.resolve");
export const canCreateException = (access: AccessSnapshot | null) =>
  canReconcile(access) && access?.dataScope === "all";
export const canReturnReceipt = (access: AccessSnapshot | null) =>
  canReconcile(access) &&
  access?.dataScope === "all" &&
  canAction(access, "finance.receipt.confirm");
export function resolutions(value: ExceptionDetail, access: AccessSnapshot | null) {
  if (!canReconcile(access) || value.status !== "open" || !value.actions.includes("resolve"))
    return [];
  return value.allowedResolutions.filter(
    (action) => action !== "written_off" || canAction(access, "sys.super_admin"),
  );
}
export function resolveBody(
  value: ExceptionDetail,
  resolution: PaymentExceptionResolveBody["resolution"],
  note: string,
  extra: Pick<PaymentExceptionResolveBody, "linkPaymentOrderId" | "offlineReturn"> = {},
): PaymentExceptionResolveBody {
  if (
    !value.allowedResolutions.includes(resolution) ||
    !value.actions.includes("resolve") ||
    value.status !== "open"
  )
    throw new Error("当前差异不可处理");
  if (
    resolution === "link_order" &&
    !value.linkCandidates.some((row) => row.paymentOrderId === extra.linkPaymentOrderId)
  )
    throw new Error("请选择当前可关联的付款单");
  return {
    lockVersion: value.lockVersion,
    resolution,
    note: note.trim(),
    confirm: { exceptionNo: value.exceptionNo, amountFen: value.amountFen },
    ...(resolution === "link_order" ? { linkPaymentOrderId: extra.linkPaymentOrderId } : {}),
    ...(resolution === "offline_return" ? { offlineReturn: extra.offlineReturn } : {}),
  };
}
export const isId = (value: string) => IdSchema.safeParse(value).success;

/** 写后先取消同key旧GET；读取完成且上下文仍有效才发布缓存。 */
export async function refreshReconcile<T>(
  cache: QueryClient,
  key: readonly unknown[],
  signal: AbortSignal,
  read: (signal: AbortSignal) => Promise<T>,
) {
  signal.throwIfAborted();
  await cache.cancelQueries({ queryKey: key, exact: true });
  signal.throwIfAborted();
  const value = await read(signal);
  signal.throwIfAborted();
  cache.setQueryData(key, value);
  return value;
}

/** 一个面板一个同步意图；未知结果保留同正文key，卸载取消后不发布迟到结果。 */
export function createReconcileIntent(makeKey = () => newIdempotencyKey("finance-reconcile")) {
  const keys = new Map<ReconCommand, { body: string; key: string }>();
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
      generation++;
      busy = false;
      controller.abort();
      keys.clear();
    },
    async submit<T>(
      command: ReconCommand,
      body: unknown,
      send: (key: string, signal: AbortSignal) => Promise<T>,
    ) {
      if (!active || busy) return undefined;
      const signature = JSON.stringify(body),
        old = keys.get(command),
        intent = old?.body === signature ? old : { body: signature, key: makeKey() };
      keys.set(command, intent);
      busy = true;
      const own = generation,
        signal = controller.signal;
      try {
        const value = await send(intent.key, signal);
        if (!active || signal.aborted || generation !== own) return undefined;
        keys.delete(command);
        return value;
      } catch (error) {
        if (active && !signal.aborted && generation === own) throw error;
        return undefined;
      } finally {
        if (generation === own) busy = false;
      }
    },
  };
}
