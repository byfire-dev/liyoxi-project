import { readTableSearch, type TableSearch } from "../../../lib/table-search";
import { choice, idValue, keyword } from "../payments/model";
import type { RefundRow } from "./api";

export const sourceLabels: Record<RefundRow["source"], string> = {
  customer_service: "客服申请",
  exception: "付款差异转入",
  staging_probe: "预发系统退款",
};
export const ruleLabels = {
  window: "窗口期退款",
  qualification_failed: "资质终审失败",
  override: "规则外退款",
  fulfillment_blocked: "履约阻断",
  unapplied_receipt: "未入账收款",
};
export const tabLabels = {
  pending_approval: "待审批",
  pending_execution: "待执行（含执行中）",
  processed: "已处理",
  all: "全部",
};
export function refundLabel(row: Pick<RefundRow, "status" | "closeReason">) {
  if (row.status === "not_executed")
    return row.closeReason === "rejected"
      ? "已驳回"
      : row.closeReason === "withdrawn"
        ? "已撤回"
        : row.closeReason === "voided"
          ? "已作废"
          : "未执行关闭";
  return {
    pending_approval: "待审批",
    pending_execution: "待执行",
    executing: "退款处理中",
    done: "已退款",
  }[row.status];
}
export const routeLabel = (value: string | null) =>
  value === "wechat_original" ? "微信原路" : value === "offline" ? "线下退款" : "—";
export function refundSearch(raw: Record<string, unknown>) {
  const paging = readTableSearch(raw);
  return {
    page: paging.page,
    pageSize: paging.pageSize,
    tab:
      choice(raw.tab, ["pending_approval", "pending_execution", "processed", "all"] as const) ??
      "pending_approval",
    q: keyword(raw.q),
    entityId: idValue(raw.entityId),
    storeId: idValue(raw.storeId),
    ruleCode: choice(raw.ruleCode, [
      "window",
      "qualification_failed",
      "override",
      "fulfillment_blocked",
      "unapplied_receipt",
    ] as const),
    source: choice(raw.source, ["customer_service", "exception", "staging_probe"] as const),
    overdueOnly: choice(raw.overdueOnly, ["true", "false"] as const),
    refundRequestId: idValue(raw.refundRequestId),
  };
}
export function refundFilters(search: ReturnType<typeof refundSearch>) {
  return {
    q: search.q,
    entityId: search.entityId,
    storeId: search.storeId,
    ruleCode: search.ruleCode,
    source: search.source,
    overdueOnly: search.overdueOnly,
  };
}
export function refundTableSearch(search: ReturnType<typeof refundSearch>): TableSearch {
  return readTableSearch(search, ["entityId", "storeId", "ruleCode", "source", "overdueOnly"]);
}
const actionLabels: Readonly<Record<string, string>> = {
  approve: "通过审批",
  reject: "驳回",
  withdraw: "撤回",
  execute: "微信原路退款",
  "record-offline": "线下退款登记",
  retry: "按原单号重试",
  "confirm-not-accepted": "确认渠道未受理",
  void: "作废",
};
export const actionLabel = (value: string) => actionLabels[value] ?? value;
