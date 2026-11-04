import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Checkbox, Input, InputNumber, Segmented } from "antd";
import { useContext, useMemo } from "react";
import { MasterDetailPage } from "../../../components/MasterDetailPage";
import { PageHeader } from "../../../components/PageHeader";
import { SimplePager } from "../../../components/SimplePager";
import { EmptyState, ErrorState, FullPageNotice } from "../../../components/StateBlock";
import { AccessContext, hasModuleLevel } from "../../../lib/permissions";
import { LIST_QUERY } from "../../../lib/query";
import { actorScope } from "../../system/staff-access";
import { createCalendarApi } from "../calendar/api";
import { ManagerFilter } from "../calendar/controls";
import { createOverdueApi } from "./api";
import { TrackDetails } from "./details";
import {
  OVERDUE_KEY,
  overdueLabel,
  overdueSearch,
  trackFilters,
  trackQuery,
  type OverdueSearch,
} from "./model";
import "../calendar/calendar.css";
import "./overdue.css";
const route = getRouteApi("/publish/overdue");
export function OverduePage() {
  const access = useContext(AccessContext);
  if (!hasModuleLevel(access, "publish"))
    return <FullPageNotice title="没有查看权限" description="请联系管理员开通发布管理查看权限" />;
  return <OverdueWorkspace key={actorScope(access)} />;
}
function OverdueWorkspace() {
  const { services } = useRouteContext({ from: "__root__" }),
    scope = actorScope(useContext(AccessContext));
  const search = overdueSearch(route.useSearch()),
    navigate = route.useNavigate();
  const api = useMemo(() => createOverdueApi(services), [services]),
    calendarApi = useMemo(() => createCalendarApi(services), [services]);
  const filters = trackFilters(search);
  const list = useQuery({
    queryKey: [...OVERDUE_KEY, scope, "list", trackQuery(search)],
    queryFn: ({ signal }) => api.list(trackQuery(search), signal),
    ...LIST_QUERY,
  });
  const summary = useQuery({
    queryKey: [...OVERDUE_KEY, scope, "summary", filters],
    queryFn: ({ signal }) => api.summary(filters, signal),
    ...LIST_QUERY,
  });
  const data = !list.isPlaceholderData && !list.isError ? list.data : undefined,
    stats = !summary.isPlaceholderData && !summary.isError ? summary.data : undefined;
  const selected =
    data?.items.find((row) => row.orderItem.orderItemId === search.id) ?? data?.items[0];
  const change = (patch: Partial<OverdueSearch>) =>
    void navigate({ search: { ...search, page: 1, id: undefined, ...patch } });
  const refresh = async () => {
    const results = await Promise.all([list.refetch(), summary.refetch()]);
    const failure = results.find((result) => result.error)?.error;
    if (failure) throw failure;
  };
  return (
    <>
      <PageHeader
        title="逾期跟进"
        subtitle="按订单项跟进上线，逐一核对各发布账号"
        extra={
          <Link to="/publish/calendar" search={{}}>
            上线日历
          </Link>
        }
      />
      <div className="lyx-launch-toolbar">
        <Input.Search
          key={search.q ?? "empty"}
          aria-label="搜索上线任务"
          placeholder="门店、剧名、订购单号、工单号"
          defaultValue={search.q}
          maxLength={64}
          allowClear
          onSearch={(q) => change({ q: q.trim() || undefined })}
        />
        <ManagerFilter
          api={calendarApi}
          value={search.managerId}
          onChange={(managerId) => change({ managerId })}
        />
        <label>
          未来天数{" "}
          <InputNumber
            aria-label="未来天数"
            min={1}
            max={30}
            precision={0}
            value={search.days}
            onChange={(days) => {
              if (days) change({ days });
            }}
          />
        </label>
        <Checkbox
          checked={search.readyOnly}
          onChange={(event) => change({ readyOnly: event.target.checked })}
        >
          仅看成片已交付
        </Checkbox>
        <Button
          onClick={() =>
            change({
              managerId: undefined,
              q: undefined,
              readyOnly: false,
              deliveryTicketId: undefined,
              orderItemId: undefined,
              days: 7,
            })
          }
        >
          清除筛选
        </Button>
        <Button
          loading={list.isFetching || summary.isFetching}
          onClick={() => {
            void list.refetch();
            void summary.refetch();
          }}
        >
          刷新任务
        </Button>
      </div>
      {search.deliveryTicketId || search.orderItemId ? (
        <Alert type="info" title="正在查看指定工单或订单项，可清除筛选查看全部可见任务" />
      ) : null}
      {summary.isError ? (
        <ErrorState message={summary.error.message} onRetry={() => void summary.refetch()} />
      ) : stats ? (
        <div className="lyx-overdue-stats" aria-label="上线任务统计">
          <div>
            <strong>{stats.overdue}</strong>
            <span>逾期未上线</span>
          </div>
          <div>
            <strong>{stats.upcoming}</strong>
            <span>{search.days} 日内待上线</span>
          </div>
          <div>
            <strong>{stats.deliveringSoon}</strong>
            <span>{search.days} 日内成片交付中</span>
          </div>
          <div>
            <strong>{stats.all}</strong>
            <span>全部已建任务订单项</span>
          </div>
        </div>
      ) : (
        <p aria-busy="true">任务统计加载中</p>
      )}
      {stats ? (
        <p className="lyx-overdue-history">
          近 30 天逾期 {stats.last30Days.overdueItemCount} 单 · 平均{" "}
          {stats.last30Days.avgOverdueDays.toFixed(1)} 天 · 当前已有账号上线{" "}
          {stats.last30Days.liveItemCount} 单
        </p>
      ) : null}
      <Segmented
        aria-label="上线任务范围"
        value={search.tab}
        options={[
          { value: "overdue", label: "逾期未上线" },
          { value: "upcoming", label: `${search.days} 日内待上线` },
          { value: "all", label: "全部上线任务" },
        ]}
        onChange={(tab) => change({ tab: tab as OverdueSearch["tab"] })}
      />
      <MasterDetailPage
        label="上线任务跟进"
        selectedKey={selected?.orderItem.orderItemId}
        onSelect={(id) => change({ id, page: search.page })}
        onRetry={() => void list.refetch()}
        detailTitle="上线任务详情"
        list={() => (
          <div className="lyx-card lyx-overdue-list">
            {list.isError ? (
              <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
            ) : !data ? (
              <div className="lyx-state" aria-busy="true">
                上线任务加载中
              </div>
            ) : !data.items.length ? (
              <EmptyState title="当前范围暂无上线任务" description="可切换范围或清除筛选" />
            ) : (
              data.items.map((row) => (
                <button
                  type="button"
                  key={row.orderItem.orderItemId}
                  className={`lyx-overdue-row${row.orderItem.orderItemId === selected?.orderItem.orderItemId ? " is-selected" : ""}`}
                  aria-pressed={row.orderItem.orderItemId === selected?.orderItem.orderItemId}
                  onClick={() => change({ id: row.orderItem.orderItemId, page: search.page })}
                >
                  <strong>{row.store.storeName ?? "未命名门店"}</strong>
                  <span>
                    {row.orderItem.dramaTitle} · {row.ticket.ticketNo}
                  </span>
                  <span className={row.overdue ? "lyx-launch-warning" : undefined}>
                    {overdueLabel(row)}
                  </span>
                  <span>
                    约定上线 {row.orderItem.agreedLaunchDate ?? "待确认"} ·{" "}
                    {row.tasks.filter((task) => task.isOverdue).length} 个账号逾期
                  </span>
                </button>
              ))
            )}
            {data ? (
              <SimplePager
                total={data.total}
                page={data.page}
                pageSize={data.pageSize}
                onPageChange={(page) => change({ page })}
                onPageSizeChange={(pageSize) => change({ pageSize })}
              />
            ) : null}
          </div>
        )}
        detail={
          selected
            ? {
                key: selected.orderItem.orderItemId,
                status: "ready",
                content: (
                  <TrackDetails
                    key={`${scope}:${JSON.stringify(trackQuery(search))}:${selected.orderItem.orderItemId}`}
                    row={selected}
                    api={api}
                    calendarApi={calendarApi}
                    refresh={refresh}
                  />
                ),
              }
            : undefined
        }
      />
    </>
  );
}
