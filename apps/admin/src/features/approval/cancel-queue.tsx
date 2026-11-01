import type { components } from "@liyoxi/contract/types/admin";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Drawer } from "antd";
import { useContext, useMemo } from "react";
import { QueryTablePage, type QueryState } from "../../components/QueryTablePage";
import { AccessContext, hasModuleLevel } from "../../lib/permissions";
import { DETAIL_QUERY, QUEUE_QUERY } from "../../lib/query";
import { readTableSearch, writeTableSearch } from "../../lib/table-search";
import { createCancelApi } from "./cancel-api";
import {
  cancelApprovalId,
  cancelKinds,
  cancelQuery,
  cancelSearch,
  cancelStatus,
  cancelSummaryQuery,
  matchesCancelApproval,
} from "./cancel-model";
import { CancelRequestPanel } from "./cancel-panel";

// actual owner schema允许系统申请 requester=null，生成的Card类型暂未保留该null。
type Card = Awaited<ReturnType<ReturnType<typeof createCancelApi>["list"]>>["items"][number];
const filters = [
  "kind",
  "reasonCode",
  "requesterId",
  "overdueOnly",
  "storeId",
  "entityId",
  "submittedFrom",
  "submittedTo",
];
export function CancelQueue({
  search,
  scope,
  onSearch,
}: {
  search: Readonly<Record<string, string>>;
  scope: string;
  onSearch: (value: Record<string, string | undefined>) => void;
}) {
  const access = useContext(AccessContext);
  return hasModuleLevel(access, "order") || hasModuleLevel(access, "finance") ? (
    <CancelQueueBody search={search} scope={scope} onSearch={onSearch} />
  ) : null;
}
function CancelQueueBody({
  search,
  scope,
  onSearch,
}: {
  search: Readonly<Record<string, string>>;
  scope: string;
  onSearch: (value: Record<string, string | undefined>) => void;
}) {
  const { services } = useRouteContext({ from: "__root__" });
  const api = useMemo(() => createCancelApi(services), [services]);
  const query = cancelQuery(search),
    summaryQuery = cancelSummaryQuery(search);
  const list = useQuery({
    queryKey: ["approval", "cancel-queue", scope, query],
    ...QUEUE_QUERY,
    queryFn: ({ signal }) => api.list(query, signal),
  });
  const summary = useQuery({
    queryKey: ["approval", "cancel-summary", scope, summaryQuery],
    ...QUEUE_QUERY,
    queryFn: ({ signal }) => api.summary(summaryQuery, signal),
  });
  const wire = Object.fromEntries(
    Object.entries(cancelSearch(search)).map(([key, value]) => [key.slice(7), value]),
  );
  const state: QueryState<Card> = list.isPending
    ? { status: "loading" }
    : list.isError
      ? { status: "error", message: "取消队列读取失败" }
      : { status: "success", items: list.data.items, total: list.data.total };
  const refresh = () => {
    void list.refetch();
    void summary.refetch();
  };
  const select = (row: Card) =>
    onSearch({ ...search, id: undefined, cancelId: row.cancelRequestId });
  return (
    <section aria-label="取消与积分退回队列">
      <h2>取消与积分退回队列</h2>
      <p>包含待审批及审批通过后待执行的取消请求；不属于现金退款。</p>
      {summary.isError ? (
        <Alert
          type="error"
          title="取消摘要读取失败"
          action={<Button onClick={() => void summary.refetch()}>重试取消摘要</Button>}
        />
      ) : (
        <p aria-busy={summary.isPending}>
          进行中 {summary.data?.inProgressCount ?? "…"} · 超期 {summary.data?.overdueCount ?? "…"} ·
          本月已退积分 {summary.data?.monthReturnedPoints ?? "…"} · 本月已执行{" "}
          {summary.data?.monthDoneCount ?? "…"}
        </p>
      )}
      <QueryTablePage<Card>
        label="取消与积分退回"
        search={readTableSearch(wire, filters)}
        defaultTab="pending_approval"
        tabs={[
          { key: "pending_approval", label: "待审批", count: summary.data?.tabs.pending_approval },
          {
            key: "pending_execution",
            label: "待执行",
            count: summary.data?.tabs.pending_execution,
          },
          { key: "processed", label: "已处理", count: summary.data?.tabs.processed },
          { key: "all", label: "全部" },
        ]}
        onSearchChange={(next) => {
          const clean = Object.fromEntries(
            Object.entries(search).filter(
              ([key]) => !key.startsWith("cancel_") && key !== "cancelId",
            ),
          );
          onSearch({
            ...clean,
            ...Object.fromEntries(
              Object.entries(writeTableSearch(next)).map(([key, value]) => [
                `cancel_${key}`,
                String(value),
              ]),
            ),
          });
        }}
        keywordPlaceholder="搜索取消单号或目标"
        filters={[
          {
            key: "kind",
            placeholder: "全部取消类型",
            options: Object.entries(cancelKinds).map(([value, label]) => ({ value, label })),
          },
          {
            key: "requesterId",
            placeholder: "全部发起人",
            options: [{ value: "me", label: "我发起的" }],
          },
          {
            key: "overdueOnly",
            placeholder: "全部时限",
            options: [{ value: "true", label: "只看超期" }],
          },
        ]}
        columns={[
          {
            key: "target",
            title: "取消目标",
            render: (row) => (
              <div>
                <strong>{row.requestNo}</strong>
                <p>
                  {cancelKinds[row.kind]} · {row.target.label}
                </p>
              </div>
            ),
          },
          { key: "store", title: "门店", render: (row) => row.store.storeName ?? "—" },
          { key: "status", title: "当前状态", render: (row) => cancelStatus[row.status] },
          { key: "points", title: "拟退积分", render: (row) => row.totalRefundPoints },
          {
            key: "requester",
            title: "发起人",
            render: (row) => (row.isSystemSubmitted ? "系统" : (row.requester?.name ?? "—")),
          },
          {
            key: "due",
            title: "当前期限",
            render: (row) => {
              const due = row.status === "pending_execution" ? row.execDueAt : row.approvalDueAt;
              return due ? appDateTimeFormat.dateTime(due) : "—";
            },
          },
          {
            key: "detail",
            title: "详情",
            render: (row) => (
              <Button type="link" onClick={() => select(row)}>
                查看取消
              </Button>
            ),
          },
        ]}
        rowKey={(row) => row.cancelRequestId}
        query={state}
        refreshing={list.isFetching && !list.isPending}
        onRetry={refresh}
        onRowClick={select}
        selectedRowKey={search.cancelId}
        rowTone={(row) => (row.isOverdue ? "danger" : undefined)}
        empty={{ title: "暂无取消请求", filteredTitle: "没有符合条件的取消请求" }}
      />
      {search.cancelId ? (
        <Drawer
          open
          width={720}
          title="取消与积分退回"
          destroyOnHidden
          onClose={() => onSearch({ ...search, cancelId: undefined })}
        >
          <CancelRequestPanel cancelRequestId={search.cancelId} onChanged={refresh} />
        </Drawer>
      ) : null}
    </section>
  );
}
/** 只有登记的三kind、完整operation映射及当前GET关系一致，才开放取消动作。 */
export function ApprovalCancelPanel({
  approval,
  scope,
  onChanged,
}: {
  approval: components["schemas"]["ApprovalDetail"];
  scope: string;
  onChanged: () => void;
}) {
  const { services } = useRouteContext({ from: "__root__" });
  const id = cancelApprovalId(approval);
  const query = useQuery({
    queryKey: ["approval", "cancel-relation", scope, approval.approvalId, id],
    ...DETAIL_QUERY,
    enabled: Boolean(id),
    queryFn: ({ signal }) => createCancelApi(services).get(id!, signal),
  });
  if (!id) return <Alert type="warning" title="取消审批映射不完整，仅展示原审批记录。" />;
  if (query.isPending) return <p aria-busy="true">正在核对取消请求…</p>;
  if (query.isError)
    return (
      <Alert
        type="error"
        title="取消请求读取失败"
        action={<Button onClick={() => void query.refetch()}>重试读取取消请求</Button>}
      />
    );
  if (!matchesCancelApproval(approval, query.data))
    return (
      <Alert type="error" title="审批与取消请求的关联已变化，请重新读取审批；当前不开放操作。" />
    );
  return <CancelRequestPanel cancelRequestId={id} onChanged={onChanged} />;
}
