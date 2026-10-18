import "../system/staff-access.css";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Drawer } from "antd";
import { useContext, useState } from "react";
import { DateRangeField, type DateRangeFieldProps } from "../../components/DateRangeField";
import { PageHeader } from "../../components/PageHeader";
import { QueryTablePage, type QueryState } from "../../components/QueryTablePage";
import { ReadOnlyValue } from "../../components/ReadOnlyValue";
import { ErrorState } from "../../components/StateBlock";
import { AccessContext } from "../../lib/permissions";
import { DETAIL_QUERY, QUEUE_QUERY } from "../../lib/query";
import { writeTableSearch } from "../../lib/table-search";
import { accessResult, actorScope } from "../system/staff-access";
import {
  APPROVAL_KEY,
  approvalSearch,
  approvalQuery,
  approvalSummaryQuery,
  approvalTable,
  approvalTarget,
  kindLabels,
  statusLabels,
  type ApprovalItem,
  type ApprovalDetail,
  type ApprovalCounts,
} from "./model";

const route = getRouteApi("/approvals");
export function ApprovalsPage() {
  const access = useContext(AccessContext);
  return <ApprovalWorkspace key={actorScope(access)} scope={actorScope(access)} />;
}
function ApprovalWorkspace({ scope }: { scope: string }) {
  const { services } = useRouteContext({ from: "__root__" });
  const navigate = route.useNavigate(),
    search = approvalSearch(route.useSearch()),
    table = approvalTable(search);
  const access = useContext(AccessContext);
  const [dates, setDates] = useState<{ wire: string; value: DateRangeFieldProps["value"] }>();
  const dateWire = `${search.submittedFrom ?? ""}/${search.submittedTo ?? ""}`;
  const query = approvalQuery(search),
    summaryQuery = approvalSummaryQuery(search);
  const list = useQuery({
    queryKey: [...APPROVAL_KEY, scope, "list", query],
    ...QUEUE_QUERY,
    queryFn: async () =>
      (await accessResult(
        await services.api.client.GET("/api/v1/admin/approvals", { params: { query } }),
      )) as unknown as { items: ApprovalItem[]; total: number },
  });
  const counts = useQuery({
    queryKey: [...APPROVAL_KEY, scope, "counts", summaryQuery],
    ...QUEUE_QUERY,
    queryFn: async () =>
      (await accessResult(
        await services.api.client.GET("/api/v1/admin/approvals/summary", {
          params: { query: summaryQuery },
        }),
      )) as unknown as ApprovalCounts,
  });
  const detail = useQuery({
    queryKey: [...APPROVAL_KEY, scope, "detail", search.id],
    enabled: Boolean(search.id),
    ...DETAIL_QUERY,
    queryFn: async () =>
      (await accessResult(
        await services.api.client.GET("/api/v1/admin/approvals/{approvalId}", {
          params: { path: { approvalId: search.id! } },
        }),
      )) as unknown as ApprovalDetail,
  });
  const patch = (value: Record<string, string | undefined>) =>
    void navigate({ search: approvalSearch({ ...search, ...value, page: "1", id: undefined }) });
  const state: QueryState<ApprovalItem> = list.isPending
    ? { status: "loading" }
    : list.isError
      ? { status: "error", message: list.error.message }
      : { status: "success", items: list.data.items, total: list.data.total };
  const sums = counts.data?.items.reduce(
    (value, row) => ({
      todo: value.todo + row.todo,
      submitted: value.submitted + row.submitted,
      done_today: value.done_today + row.doneToday,
      all: value.all + row.all,
    }),
    { todo: 0, submitted: 0, done_today: 0, all: 0 },
  );
  return (
    <>
      <PageHeader
        title="我的待审批"
        subtitle="仅显示当前已登记且有权限读取的审批；动作在所属业务中完成。"
      />
      {counts.isError ? (
        <Alert
          type="error"
          title={counts.error.message}
          action={<Button onClick={() => void counts.refetch()}>重试摘要</Button>}
        />
      ) : (
        <p aria-busy={counts.isPending}>
          待本人处理 {counts.data?.total.todo ?? "…"} · 超期 {counts.data?.total.overdue ?? "…"}
        </p>
      )}
      <div className="lyx-access-actions" aria-label="审批提交日期筛选">
        <DateRangeField
          aria-label="提交日期范围"
          format="YYYY-MM-DD"
          placeholder={[search.submittedFrom ?? "开始日期", search.submittedTo ?? "结束日期"]}
          value={dates?.wire === dateWire ? dates.value : null}
          onChange={(value, text) => {
            setDates({ value, wire: `${text[0]}/${text[1]}` });
            patch({ submittedFrom: text[0] || undefined, submittedTo: text[1] || undefined });
          }}
        />
        <span>
          {search.submittedFrom ?? "不限开始"} 至 {search.submittedTo ?? "不限结束"}（北京时间）
        </span>
        <Button
          onClick={() => {
            setDates(undefined);
            patch({ submittedFrom: undefined, submittedTo: undefined });
          }}
        >
          清除日期
        </Button>
      </div>
      <QueryTablePage<ApprovalItem>
        label="我的审批"
        search={table}
        defaultTab="todo"
        tabs={[
          { key: "todo", label: "待我处理", count: sums?.todo },
          { key: "submitted", label: "我发起的", count: sums?.submitted },
          { key: "done_today", label: "今日已处理", count: sums?.done_today },
          { key: "all", label: "全部", count: sums?.all },
        ]}
        onSearchChange={(next) => void navigate({ search: approvalSearch(writeTableSearch(next)) })}
        keywordPlaceholder="搜索审批摘要或单号"
        filters={[
          {
            key: "kind",
            placeholder: "全部已登记类型",
            options:
              counts.data?.items.map((row) => ({
                value: row.kind,
                label: kindLabels[row.kind] ?? row.kind,
              })) ?? [],
          },
          {
            key: "status",
            placeholder: "全部状态",
            options: Object.entries(statusLabels).map(([value, label]) => ({ value, label })),
          },
          {
            key: "overdue",
            placeholder: "全部时限",
            options: [{ value: "true", label: "只看超期" }],
          },
        ]}
        columns={[
          {
            key: "summary",
            title: "审批摘要",
            render: (row) => (
              <div className="lyx-cell-2">
                <strong>{row.summary.title}</strong>
                <span className="lyx-cell-2__sub">
                  {row.requestNo ?? "—"} · {kindLabels[row.kind] ?? row.kind}
                </span>
              </div>
            ),
          },
          {
            key: "status",
            title: "状态",
            width: 100,
            render: (row) => statusLabels[row.status] ?? row.status,
          },
          { key: "submitter", title: "发起人", width: 110, render: (row) => row.submitter.label },
          {
            key: "submitted",
            title: "提交时间",
            width: 150,
            sortField: "submittedAt",
            render: (row) => appDateTimeFormat.dateTime(row.submittedAt),
          },
          {
            key: "due",
            title: "时限",
            width: 150,
            render: (row) => (
              <span>
                {row.dueAt ? appDateTimeFormat.dateTime(row.dueAt) : "无固定时限"}
                {row.badges.includes("overdue") ? " · 已超期" : ""}
              </span>
            ),
          },
          {
            key: "detail",
            title: "详情",
            width: 80,
            render: (row) => (
              <Button
                type="link"
                size="small"
                onClick={() => void navigate({ search: { ...search, id: row.approvalId } })}
              >
                查看
              </Button>
            ),
          },
        ]}
        rowKey={(row) => row.approvalId}
        query={state}
        refreshing={list.isFetching && !list.isPending}
        onRetry={() => void list.refetch()}
        selectedRowKey={search.id}
        onRowClick={(row) => void navigate({ search: { ...search, id: row.approvalId } })}
        rowTone={(row) => (row.badges.includes("overdue") ? "danger" : undefined)}
        empty={{ title: "暂无审批", filteredTitle: "没有符合条件的审批" }}
      />
      {search.id ? (
        <Drawer
          open
          title="审批详情"
          onClose={() => {
            const next = { ...search };
            delete next.id;
            void navigate({ search: next });
          }}
          destroyOnHidden
        >
          {detail.isPending ? (
            <p aria-busy="true">正在读取审批…</p>
          ) : detail.isError ? (
            <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />
          ) : (
            <>
              <h3>{detail.data.summary.title}</h3>
              <ReadOnlyValue
                label="类型 / 状态"
                value={`${kindLabels[detail.data.kind] ?? detail.data.kind} / ${statusLabels[detail.data.status]}`}
              />
              {detail.data.summary.lines?.map((line, index) => (
                <ReadOnlyValue key={index} label={line.label} value={line.value} />
              ))}
              <ReadOnlyValue label="处理人" value={detail.data.handler?.name ?? "未指定"} />
              <ReadOnlyValue
                label="决定人"
                value={
                  detail.data.isDecidedBySystem ? "系统" : (detail.data.decidedBy?.name ?? "—")
                }
              />
              <ReadOnlyValue
                label="决定时间"
                value={
                  detail.data.decidedAt ? appDateTimeFormat.dateTime(detail.data.decidedAt) : "—"
                }
              />
              <ReadOnlyValue label="决定说明" value={detail.data.decisionNote ?? "—"} />
              <ReadOnlyValue
                label="原因"
                value={detail.data.reasons.map((row) => row.name).join("、") || "—"}
              />
              <ol>
                {detail.data.timeline.map((row, index) => (
                  <li key={index}>
                    {appDateTimeFormat.dateTime(row.occurredAt)} · {row.actorLabel} · {row.toState}
                    {row.note ? ` · ${row.note}` : ""}
                  </li>
                ))}
              </ol>
              {approvalTarget(detail.data, access) ? (
                <a className="lyx-link" href={approvalTarget(detail.data, access)!}>
                  {detail.data.actions.length ? "进入业务处理" : "查看业务详情"}
                </a>
              ) : (
                <p>当前为只读详情；该类型的领域处理入口尚未落地或当前权限不可进入。</p>
              )}
            </>
          )}
        </Drawer>
      ) : null}
    </>
  );
}
