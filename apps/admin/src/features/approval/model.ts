import { ApprovalListQuerySchema } from "@liyoxi/contract/queries/admin";
import type { components, operations } from "@liyoxi/contract/types/admin";
import { readContractQuery } from "../../lib/contract-query";
import { canEnterPage, findPage } from "../../lib/menu";
import type { AccessSnapshot } from "../../lib/permissions";
import { readTableSearch } from "../../lib/table-search";

export type ApprovalItem = components["schemas"]["ApprovalItem"];
export type ApprovalDetail = components["schemas"]["ApprovalDetail"];
export type ApprovalCounts = components["schemas"]["ApprovalCounts"];
type Query = NonNullable<operations["admin.approval.list"]["parameters"]["query"]>;
export const APPROVAL_KEY = ["approval", "mine"] as const;
export const filterKeys = [
  "kind",
  "status",
  "overdue",
  "submittedFrom",
  "submittedTo",
  "storeId",
  "entityId",
] as const;
const keys = ["q", "tab", "sort", "page", "pageSize", ...filterKeys];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function approvalSearch(raw: Readonly<Record<string, unknown>>) {
  const table = readTableSearch(raw, filterKeys);
  const input: Record<string, unknown> = { ...raw, page: table.page, pageSize: table.pageSize };
  if (
    typeof input.submittedFrom === "string" &&
    typeof input.submittedTo === "string" &&
    input.submittedFrom > input.submittedTo
  ) {
    delete input.submittedFrom;
    delete input.submittedTo;
  }
  const { wire } = readContractQuery(ApprovalListQuerySchema, input, {
    keys,
    defaults: { tab: "todo", page: "1", pageSize: "20" },
    keywordLimit: 30,
  });
  if (typeof raw.id === "string" && uuid.test(raw.id)) wire.id = raw.id;
  return wire;
}
export function approvalQuery(raw: Readonly<Record<string, unknown>>): Query {
  const { id: _id, ...wire } = approvalSearch(raw);
  void _id;
  const { tab, sort } = ApprovalListQuerySchema.parse(wire);
  return {
    ...wire,
    tab,
    sort,
    page: Number(wire.page),
    pageSize: Number(wire.pageSize),
    overdue: wire.overdue === "true" ? "true" : wire.overdue === "false" ? "false" : undefined,
  };
}
export function approvalSummaryQuery(raw: Readonly<Record<string, unknown>>) {
  const { kind, storeId, entityId, q, overdue, submittedFrom, submittedTo } = approvalQuery(raw);
  return { kind, storeId, entityId, q, overdue, submittedFrom, submittedTo };
}
export function approvalTable(raw: Readonly<Record<string, unknown>>) {
  return readTableSearch(approvalSearch(raw), filterKeys);
}
export const kindLabels: Readonly<Record<string, string>> = {
  qualification: "商家资质",
  channel_account: "发布账号",
  launch_link: "上线链接",
  finance_config_change: "受控财务配置",
  transfer_confirm: "付款凭证核对",
};
export const statusLabels: Readonly<Record<string, string>> = {
  pending: "待处理",
  approved: "已通过",
  rejected: "已驳回",
  withdrawn: "已撤回",
};
/** 只使用已落地页面和准确的领域GET符号；不把服务端字符串拼成任意URL/调用。 */
export function approvalTarget(
  value: Pick<ApprovalDetail, "approvalId" | "operations"> & { kind: string },
  access: AccessSnapshot | null,
) {
  const targets: Readonly<Record<string, { operation: string; page: string; path: string }>> = {
    qualification: {
      operation: "admin.qualificationSubmission.get",
      page: "merchant.review",
      path: "/merchants/review",
    },
    channel_account: {
      operation: "admin.channelAccountSubmission.get",
      page: "publish.accounts",
      path: "/publish/accounts",
    },
    launch_link: {
      operation: "admin.launchSubmission.get",
      page: "publish.verify",
      path: "/publish/verify",
    },
  };
  const target = targets[value.kind],
    page = target && findPage(target.page);
  return target &&
    page?.implemented &&
    canEnterPage(access, page) &&
    value.operations.get === target.operation &&
    uuid.test(value.approvalId)
    ? `${target.path}?id=${encodeURIComponent(value.approvalId)}`
    : null;
}
