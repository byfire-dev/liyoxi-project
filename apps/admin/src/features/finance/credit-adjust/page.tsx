import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Card, Input, Space } from "antd";
import { useContext, useEffect } from "react";
import { InfoList } from "../../../components/InfoList";
import { MasterDetailPage } from "../../../components/MasterDetailPage";
import { PageHeader } from "../../../components/PageHeader";
import { QueryTablePage, type QueryColumn } from "../../../components/QueryTablePage";
import { AccessContext } from "../../../lib/permissions";
import { DETAIL_QUERY, QUEUE_QUERY } from "../../../lib/query";
import { writeTableSearch, type TableSearch } from "../../../lib/table-search";
import { financeScope } from "../payments/model";
import { adjustmentError, createAdjustmentApi, type AdjustmentRow } from "./api";
import { AdjustmentDecision } from "./decision";
import { AdjustmentDetail, points } from "./detail";
import {
  adjustmentFilters,
  adjustmentSearch,
  adjustmentTable,
  adjustmentView,
  refreshAdjustmentDetail,
  kindLabels,
  readableKinds,
  statusLabels,
  tabLabels,
} from "./model";

const route = getRouteApi("/finance/credit-adjust");
export function CreditAdjustPage() {
  return <AdjustmentWorkspace key={financeScope(useContext(AccessContext))} />;
}
function AdjustmentWorkspace() {
  const access = useContext(AccessContext),
    scope = financeScope(access),
    allowed = readableKinds(access),
    { services } = useRouteContext({ from: "__root__" }),
    api = createAdjustmentApi(services),
    search = adjustmentSearch(route.useSearch()),
    navigate = route.useNavigate(),
    cache = useQueryClient(),
    filters = adjustmentFilters(search, allowed),
    prefix = ["finance", scope, "credit-adjust"] as const,
    { status: _status, ...summaryFilters } = filters,
    { invalidRange, denied, enabled, selectedId } = adjustmentView(search, allowed);
  void _status;
  const list = useQuery({
      queryKey: [...prefix, "list", filters, search.tab, search.sort, search.page, search.pageSize],
      queryFn: ({ signal }) =>
        api.list(
          {
            ...filters,
            tab: search.tab,
            sort: search.sort,
            page: search.page,
            pageSize: search.pageSize,
          },
          signal,
        ),
      enabled,
      ...QUEUE_QUERY,
      placeholderData: undefined,
    }),
    summary = useQuery({
      queryKey: [...prefix, "summary", summaryFilters],
      queryFn: ({ signal }) => api.summary(summaryFilters, signal),
      enabled,
      ...QUEUE_QUERY,
      placeholderData: undefined,
    }),
    detailKey = [...prefix, "detail", selectedId],
    detail = useQuery({
      queryKey: detailKey,
      queryFn: ({ signal }) => api.get(selectedId!, allowed, signal),
      enabled: !!selectedId,
      ...DETAIL_QUERY,
    });
  const select = (id: string | undefined) => void navigate({ search: { ...search, id } }),
    change = (next: TableSearch) =>
      void navigate({ search: adjustmentSearch(writeTableSearch(next)) }),
    dateChange = (key: "submittedFrom" | "submittedTo", value: string) =>
      void navigate({
        search: adjustmentSearch({ ...search, [key]: value, page: 1, id: undefined }),
      });
  useEffect(() => {
    if (!list.data || list.isFetching || list.isError || !enabled) return;
    const last = Math.max(1, Math.ceil(list.data.total / list.data.pageSize));
    if (search.page > last)
      void navigate({ search: { ...search, page: last, id: undefined }, replace: true });
  }, [list.data, list.isFetching, list.isError, enabled, search, navigate]);
  const columns: QueryColumn<AdjustmentRow>[] = [
    {
      key: "request",
      title: "申请单 / 类型",
      render: (row) => (
        <div className="lyx-cell-2">
          <strong>{row.requestNo ?? "未编号"}</strong>
          <span className="lyx-cell-2__sub">
            {row.kind === "points_adjust"
              ? kindLabels.points_adjust
              : kindLabels.subscription_extend}
          </span>
        </div>
      ),
    },
    {
      key: "summary",
      title: "申请摘要",
      render: (row) => (
        <div className="lyx-cell-2">
          <strong>{row.summary.title}</strong>
          <span className="lyx-cell-2__sub">
            {row.summary.lines?.map((line) => `${line.label}：${line.value}`).join("；") ?? "—"}
          </span>
        </div>
      ),
    },
    {
      key: "requester",
      title: "发起人 / 状态",
      render: (row) => (
        <div className="lyx-cell-2">
          <span>{row.requester?.name ?? row.submitter.label}</span>
          <span className="lyx-cell-2__sub">
            {statusLabels[row.status]}
            {row.badges.includes("overdue") ? " · 超时" : ""}
          </span>
        </div>
      ),
    },
    {
      key: "submitted",
      title: "提交时间",
      render: (row) => appDateTimeFormat.dateTimeFull(row.submittedAt),
    },
    {
      key: "due",
      title: "处理时限",
      render: (row) => (row.dueAt ? appDateTimeFormat.dateTimeFull(row.dueAt) : "—"),
    },
    {
      key: "detail",
      title: "详情",
      render: (row) => (
        <Button type="link" onClick={() => select(row.approvalId)}>
          查看审批
        </Button>
      ),
    },
  ];
  const counts = summary.isError || !enabled ? undefined : summary.data,
    tabCount = (tab: keyof typeof tabLabels) =>
      counts?.items.reduce(
        (total, item) => total + item[tab === "done_today" ? "doneToday" : tab],
        0,
      );
  return (
    <>
      <PageHeader
        title="积分调整与补偿延长"
        subtitle="真实申请、当前效果与不同人审批；通过后由服务端执行"
      />
      {!allowed.includes("subscription_extend") ? (
        <Alert type="info" title="当前可查看积分调整；补偿延长需要订购或套餐模块的查看权限" />
      ) : null}
      {denied ? <Alert type="warning" title="当前权限无法读取所选申请类型，请调整筛选" /> : null}
      {invalidRange ? <Alert type="warning" title="提交开始日期不能晚于结束日期" /> : null}
      {summary.isError && enabled ? (
        <Alert
          type="warning"
          title={adjustmentError(summary.error)}
          action={<Button onClick={() => void summary.refetch()}>重试统计</Button>}
        />
      ) : null}
      {counts ? (
        <Card title="审批概况">
          <InfoList
            labelWidth={110}
            items={[
              { label: "待我处理", value: counts.total.todo },
              { label: "超时", value: counts.total.overdue },
              {
                label: "本月增加积分",
                value: counts.pointsAdjustMonth
                  ? points(counts.pointsAdjustMonth.increasePoints)
                  : "—",
              },
              {
                label: "本月扣减积分",
                value: counts.pointsAdjustMonth
                  ? points(counts.pointsAdjustMonth.decreasePoints)
                  : "—",
              },
            ]}
          />
        </Card>
      ) : null}
      <MasterDetailPage
        label="积分调整与补偿延长主从详情"
        selectedKey={selectedId}
        onSelect={select}
        detailTitle="申请详情与审批"
        onRetry={() => void detail.refetch()}
        detail={
          selectedId
            ? detail.isPending
              ? { key: selectedId, status: "loading" }
              : detail.isError
                ? { key: selectedId, status: "error", message: adjustmentError(detail.error) }
                : {
                    key: selectedId,
                    status: "ready",
                    content: (
                      <div key={selectedId}>
                        <AdjustmentDetail value={detail.data!} />
                        <AdjustmentDecision
                          key={selectedId}
                          value={detail.data!}
                          api={api}
                          refresh={(signal) =>
                            refreshAdjustmentDetail(cache, detailKey, signal, (own) =>
                              api.get(selectedId!, allowed, own),
                            )
                          }
                          changed={() => {
                            void cache.invalidateQueries({ queryKey: [...prefix, "list"] });
                            void cache.invalidateQueries({ queryKey: [...prefix, "summary"] });
                          }}
                        />
                      </div>
                    ),
                  }
            : undefined
        }
        list={({ selectedKey, onSelect }) => (
          <QueryTablePage
            label="积分调整与补偿延长申请"
            search={adjustmentTable(search)}
            onSearchChange={change}
            defaultTab="todo"
            tabs={Object.entries(tabLabels).map(([key, label]) => ({
              key,
              label,
              count: tabCount(key as keyof typeof tabLabels),
            }))}
            keywordPlaceholder="搜索申请单号或摘要（最多30字）"
            filters={[
              {
                key: "kind",
                placeholder: "全部可读类型",
                options: allowed.map((value) => ({ value, label: kindLabels[value] })),
              },
              {
                key: "status",
                placeholder: "全部状态",
                options: Object.entries(statusLabels).map(([value, label]) => ({ value, label })),
              },
              {
                key: "overdue",
                placeholder: "全部时限",
                options: [
                  { value: "true", label: "仅超时" },
                  { value: "false", label: "仅未超时" },
                ],
              },
            ]}
            toolbar={
              <Space wrap>
                <Input
                  type="date"
                  aria-label="提交开始日期"
                  value={search.submittedFrom ?? ""}
                  onChange={(event) => dateChange("submittedFrom", event.target.value)}
                />
                <span>至</span>
                <Input
                  type="date"
                  aria-label="提交结束日期"
                  value={search.submittedTo ?? ""}
                  onChange={(event) => dateChange("submittedTo", event.target.value)}
                />
              </Space>
            }
            columns={columns}
            rowKey={(row) => row.approvalId}
            selectedRowKey={selectedKey}
            onRowClick={(row) => onSelect(row.approvalId)}
            rowTone={(row) => (row.badges.includes("overdue") ? "danger" : undefined)}
            query={
              !enabled
                ? {
                    status: "error",
                    message: denied ? "所选申请类型不可读，请调整筛选" : "请调整提交日期区间",
                  }
                : list.isPending
                  ? { status: "loading" }
                  : list.isError
                    ? { status: "error", message: adjustmentError(list.error) }
                    : { status: "success", items: list.data.items, total: list.data.total }
            }
            refreshing={list.isFetching}
            onRetry={() => {
              if (enabled) void list.refetch();
            }}
            empty={{ title: "暂无审批申请", filteredTitle: "没有符合条件的审批申请" }}
          />
        )}
      />
    </>
  );
}
