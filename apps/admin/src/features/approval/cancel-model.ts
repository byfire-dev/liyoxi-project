import {
  CancelApproveBodySchema,
  CancelExecuteBodySchema,
  CancelRejectBodySchema,
  CancelWithdrawBodySchema,
  CancelVoidBodySchema,
  CancelRequestListQuerySchema,
  IdSchema,
} from "@liyoxi/contract";
import type { components, operations } from "@liyoxi/contract/types/admin";
import { newIdempotencyKey } from "../../lib/idempotency";
import { readContractQuery } from "../../lib/contract-query";
import { canAction, type AccessSnapshot } from "../../lib/permissions";
import { canEnterPage, findPage } from "../../lib/menu";
import { readTableSearch } from "../../lib/table-search";
import { CancelFailure, type CancelCommand, type CancelDetail } from "./cancel-api";

export const cancelKinds = {
  order_cancel: "订单取消",
  ad_cancel: "广告取消",
  qualification_cancel: "资质终拒取消",
} as const;
export const cancelStatus = {
  pending_approval: "待审批",
  pending_execution: "待执行",
  done: "已执行",
  not_executed: "未执行",
} as const;
export const cancelActionLabels = {
  approve: "批准取消",
  reject: "驳回取消",
  withdraw: "撤回取消",
  void: "作废取消",
  execute: "执行积分退回",
} as const;
export type CancelAction = CancelCommand["action"];
export function cancelDecisionFacts(value: CancelDetail) {
  return JSON.stringify([
    value.cancelRequestId,
    value.kind,
    value.store.entityId,
    value.store.storeId,
    value.requestNo,
    value.totalBasePoints,
    value.totalDeductPoints,
    value.totalRefundPoints,
    value.status,
    value.approvalStatus,
    value.approval.approvalId,
    value.approval.lockVersion,
    value.actions,
    value.approval.actions,
    value.requester?.staffId,
    value.approval.requester?.staffId,
    value.lines,
    value.destination,
  ]);
}
export function isCancelRejected(error: unknown): error is CancelFailure {
  return (
    error instanceof CancelFailure &&
    error.explicitBody &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429 &&
    !["IDEMPOTENCY_IN_PROGRESS", "BUSY", "IDEMPOTENCY_KEY_REUSED"].includes(error.code)
  );
}
export class CancelRecheckFailure extends Error {
  constructor(readonly detail: CancelDetail) {
    super("PRECONDITION_CHANGED");
  }
}
type Approval = components["schemas"]["ApprovalDetail"];
export function cancelApprovalId(
  value: Pick<Approval, "approvalId" | "kind" | "domain" | "operations">,
) {
  return Object.hasOwn(cancelKinds, value.kind) &&
    IdSchema.safeParse(value.approvalId).success &&
    value.domain?.type === "cancel_request" &&
    IdSchema.safeParse(value.domain.id).success &&
    value.operations.get === "admin.cancelRequest.get" &&
    value.operations.approve === "admin.cancelRequest.approve" &&
    value.operations.reject === "admin.cancelRequest.reject" &&
    value.operations.withdraw === "admin.cancelRequest.withdraw"
    ? value.domain.id
    : null;
}
export function matchesCancelApproval(approval: Approval, detail: CancelDetail) {
  return (
    cancelApprovalId(approval) === detail.cancelRequestId &&
    approval.kind === detail.kind &&
    approval.approvalId === detail.approval.approvalId &&
    approval.storeId === detail.store.storeId &&
    approval.entityId === detail.store.entityId &&
    detail.approval.kind === detail.kind
  );
}
export function cancelActions(detail: CancelDetail, access: AccessSnapshot | null): CancelAction[] {
  if (!access) return [];
  return detail.actions.filter((action) => {
    if (action === "execute")
      return detail.status === "pending_execution" && canAction(access, "finance.refund.execute");
    if (action === "void")
      return (
        detail.status === "pending_execution" &&
        canAction(access, "order.refund.request") &&
        detail.requester?.staffId === access.staff.id
      );
    if (detail.status !== "pending_approval" || !detail.approval.actions.includes(action))
      return false;
    if (action === "withdraw") return true; // 代录/系统申请的可撤回性以 owner 当前 actions 为准。
    return (
      canAction(access, "finance.refund.approve") &&
      detail.requester?.staffId !== access.staff.id &&
      detail.approval.requester?.staffId !== access.staff.id
    );
  });
}
export function cancelCommand(
  detail: CancelDetail,
  action: CancelAction,
  note: string,
): CancelCommand {
  const confirm = { requestNo: detail.requestNo, totalRefundPoints: detail.totalRefundPoints };
  switch (action) {
    case "approve":
      return {
        action,
        body: CancelApproveBodySchema.parse({
          lockVersion: detail.approval.lockVersion,
          confirm,
          confirmChecks: ["stage_rule_amount_checked"],
        }),
      };
    case "execute":
      return {
        action,
        body: CancelExecuteBodySchema.parse({ confirm, confirmChecks: ["order_points_checked"] }),
      };
    case "reject":
      return { action, body: CancelRejectBodySchema.parse({ note }) };
    case "void":
      return { action, body: CancelVoidBodySchema.parse({ note }) };
    case "withdraw":
      return { action, body: CancelWithdrawBodySchema.parse({ note: note.trim() || undefined }) };
  }
}
/** 未知结果锁定原正文/原key；POST 已受理但读取失败时只允许 GET，切 scope 立即废弃迟到结果。 */
export function createCancelIntent(makeKey = () => newIdempotencyKey("cancel-decision")) {
  let active = true,
    busy = false,
    accepted = false;
  let intent: { command: CancelCommand; key: string; possiblySent: boolean } | undefined;
  let controller = new AbortController();
  return {
    get pending() {
      return busy;
    },
    get accepted() {
      return accepted;
    },
    get unresolved() {
      return intent !== undefined;
    },
    get command() {
      return intent?.command;
    },
    activate() {
      if (!active) {
        active = true;
        controller = new AbortController();
      }
    },
    close() {
      active = false;
      controller.abort();
      busy = false;
    },
    async submit(
      command: CancelCommand,
      send: (command: CancelCommand, key: string, signal: AbortSignal) => Promise<void>,
      read: (signal: AbortSignal) => Promise<CancelDetail>,
      verify: (fresh: CancelDetail) => boolean,
    ) {
      if (!active || busy || accepted) return undefined;
      if (intent && JSON.stringify(intent.command) !== JSON.stringify(command))
        throw new CancelFailure("UNRESOLVED_INTENT");
      intent ??= { command, key: makeKey(), possiblySent: false };
      busy = true;
      const signal = controller.signal;
      let attemptingWrite = false;
      try {
        const fresh = await read(signal);
        if (!active || signal.aborted) return undefined;
        if (!verify(fresh)) {
          // 未知POST若已发出，当前GET的状态变化不能证明原写失败；保原key但停止再写。
          if (!intent.possiblySent) intent = undefined;
          throw new CancelRecheckFailure(fresh);
        }
        intent.possiblySent = true;
        attemptingWrite = true;
        await send(intent.command, intent.key, signal);
        attemptingWrite = false;
        if (!active || signal.aborted) return undefined;
        accepted = true;
        const detail = await read(signal);
        if (!active || signal.aborted) return undefined;
        accepted = false;
        intent = undefined;
        return detail;
      } catch (error) {
        if (!active || signal.aborted) return undefined;
        if (attemptingWrite && !accepted && isCancelRejected(error)) intent = undefined;
        throw error;
      } finally {
        if (active && !signal.aborted) busy = false;
      }
    },
    async refresh(read: (signal: AbortSignal) => Promise<CancelDetail>) {
      if (!active || busy) return undefined;
      busy = true;
      const signal = controller.signal;
      try {
        const detail = await read(signal);
        if (!active || signal.aborted) return undefined;
        // 网络未知不能由一次GET推断POST没执行；保原key，允许精确重放。已受理则完成GET-only恢复。
        if (accepted) {
          accepted = false;
          intent = undefined;
        }
        return detail;
      } finally {
        if (active && !signal.aborted) busy = false;
      }
    },
  };
}
const filterKeys = [
  "q",
  "kind",
  "reasonCode",
  "storeId",
  "entityId",
  "requesterId",
  "overdueOnly",
  "submittedFrom",
  "submittedTo",
] as const;
const queryKeys = [...filterKeys, "tab", "sort", "page", "pageSize"];
export function cancelSearch(raw: Readonly<Record<string, unknown>>) {
  const input = Object.fromEntries(queryKeys.map((key) => [key, raw[`cancel_${key}`]]));
  const table = readTableSearch(
    input,
    filterKeys.filter((key) => key !== "q"),
  );
  const { wire } = readContractQuery(
    CancelRequestListQuerySchema,
    { ...input, page: table.page, pageSize: table.pageSize },
    {
      keys: queryKeys,
      defaults: { tab: "pending_approval", page: "1", pageSize: "20" },
      keywordLimit: 40,
    },
  );
  return Object.fromEntries(Object.entries(wire).map(([key, value]) => [`cancel_${key}`, value]));
}
export function cancelQuery(
  raw: Readonly<Record<string, unknown>>,
): NonNullable<operations["admin.cancelRequest.list"]["parameters"]["query"]> {
  const wire = Object.fromEntries(
    Object.entries(cancelSearch(raw)).map(([key, value]) => [key.slice(7), value]),
  );
  const parsed = CancelRequestListQuerySchema.parse(wire);
  return {
    ...wire,
    tab: parsed.tab,
    sort: parsed.sort,
    page: parsed.page,
    pageSize: parsed.pageSize,
    overdueOnly: wire.overdueOnly as "true" | "false" | undefined,
  };
}
export function cancelSummaryQuery(raw: Readonly<Record<string, unknown>>) {
  const { tab: _tab, sort: _sort, page: _page, pageSize: _size, ...filters } = cancelQuery(raw);
  return filters;
}
export function cancelTarget(detail: CancelDetail, access: AccessSnapshot | null) {
  const target =
    detail.kind === "order_cancel" && detail.order
      ? { page: "order.detail", path: `/orders/${encodeURIComponent(detail.order.orderNo)}` }
      : detail.kind === "ad_cancel" && detail.ad
        ? {
            page: "delivery.ad_tasks",
            path: `/delivery/ad-tasks?id=${encodeURIComponent(detail.ad.adId)}`,
          }
        : detail.kind === "qualification_cancel"
          ? {
              page: "merchant.detail",
              path: `/merchants/${encodeURIComponent(detail.store.storeId)}`,
            }
          : null;
  const page = target && findPage(target.page);
  return target && page?.implemented && canEnterPage(access, page) ? target.path : null;
}
