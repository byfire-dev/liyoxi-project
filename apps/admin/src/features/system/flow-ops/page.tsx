import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Select, Table, type TableColumnsType } from "antd";
import { useContext, useState } from "react";
import { PageHeader } from "../../../components/PageHeader";
import {
  QueryTablePage,
  type QueryColumn,
  type QueryState,
} from "../../../components/QueryTablePage";
import { EmptyState, ErrorState } from "../../../components/StateBlock";
import { Tabs } from "../../../components/Tabs";
import { AccessContext, type AccessSnapshot } from "../../../lib/permissions";
import { LIST_QUERY } from "../../../lib/query";
import { writeTableSearch, type TableSearch } from "../../../lib/table-search";
import { createFlowOpsApi, type OutboxView, type TimerView, type WebhookView } from "./api";
import { FlowActionDialog, actionTitle } from "./actions";
import { FlowFilters } from "./filters";
import {
  FLOW_KEY,
  TABS,
  actionAllowed,
  actorKey,
  changeFilter,
  cursorScope,
  flowSearch,
  flowTab,
  outboxQuery,
  safeSummary,
  safeText,
  statusLabel,
  tableSearch,
  timerQuery,
  webhookQuery,
  type FlowAction,
  type FlowSearch,
} from "./model";
import "./flow-ops.css";
import { MediaJobsTab } from "./media-page";
import { canReadMedia } from "./media-model";
const route = getRouteApi("/sys/flow-ops");
const at = (value: string | null) => (value ? appDateTimeFormat.dateTime(new Date(value)) : "—");
function queryState<Row>(query: {
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  data?: { items: Row[]; total: number };
}): QueryState<Row> {
  return query.isPending
    ? { status: "loading" }
    : query.isError
      ? { status: "error", message: query.error?.message }
      : { status: "success", items: query.data?.items ?? [], total: query.data?.total ?? 0 };
}
export function FlowOpsPage() {
  const access = useContext(AccessContext);
  if (flowTab(route.useSearch()) === "media")
    return <MediaJobsTab key={actorKey(access)} access={access} />;
  return <FlowOpsContent key={actorKey(access)} access={access} />;
}
function FlowOpsContent({ access }: { access: AccessSnapshot | null }) {
  const { services } = useRouteContext({ from: "__root__" }),
    navigate = route.useNavigate(),
    search = flowSearch(route.useSearch()),
    tab = flowTab(search),
    api = createFlowOpsApi(services),
    identity = actorKey(access);
  const tabs = TABS.filter((item) => item.key !== "media" || canReadMedia(access));
  const [action, setAction] = useState<FlowAction>(),
    [notice, setNotice] = useState<string>();
  const [history, setHistory] = useState<{
    scope: string;
    previous: Record<string, string | undefined>;
  }>({ scope: "", previous: {} });
  const timers = useQuery({
    queryKey: [...FLOW_KEY, identity, "timers", timerQuery(search)],
    queryFn: () => api.timers(timerQuery(search)),
    enabled: tab === "timers",
    ...LIST_QUERY,
    placeholderData: undefined,
  });
  const outbox = useQuery({
    queryKey: [...FLOW_KEY, identity, "outbox", outboxQuery(search)],
    queryFn: () => api.outbox(outboxQuery(search)),
    enabled: tab === "outbox",
    ...LIST_QUERY,
    placeholderData: undefined,
  });
  const webhooks = useQuery({
    queryKey: [...FLOW_KEY, identity, "webhooks", webhookQuery(search)],
    queryFn: () => api.webhooks(webhookQuery(search)),
    enabled: tab === "webhooks",
    ...LIST_QUERY,
    placeholderData: undefined,
  });
  const change = (next: FlowSearch) => {
    setAction(undefined);
    setNotice(undefined);
    void navigate({ search: next });
  };
  const filter = (patch: Record<string, string | undefined>) => {
    setHistory({ scope: "", previous: {} });
    change(changeFilter(search, patch));
  };
  const changeTable = (next: TableSearch) => {
    if (next.tab !== tab) {
      setHistory({ scope: "", previous: {} });
      change(flowSearch({ tab: next.tab }));
    } else change(flowSearch({ ...search, page: "1", pageSize: "20", ...writeTableSearch(next) }));
  };
  const refresh = () =>
    services.queryClient.invalidateQueries({ queryKey: [...FLOW_KEY, identity] });
  const buttons = (items: FlowAction[]) => (
    <span className="lyx-flow-actions">
      {items
        .filter((item) => actionAllowed(access, item))
        .map((item) => (
          <Button type="link" key={item.kind} onClick={() => setAction(item)}>
            {actionTitle(item.kind)}
          </Button>
        ))}
    </span>
  );
  const timerColumns: QueryColumn<TimerView>[] = [
    {
      key: "kind",
      title: "规则 / 定时器",
      width: 186,
      render: (row) => (
        <span className="lyx-cell-2">
          {safeText(row.kind)}
          <span className="lyx-cell-2__sub" title={row.timerId}>
            {row.timerId.slice(-8)}
          </span>
        </span>
      ),
    },
    {
      key: "subject",
      title: "业务对象",
      width: 180,
      render: (row) =>
        row.subject ? (
          <span className="lyx-cell-2">
            {safeText(row.subject.type)}
            <span className="lyx-cell-2__sub" title={row.subject.id}>
              {row.subject.id}
            </span>
          </span>
        ) : (
          "周期任务"
        ),
    },
    { key: "status", title: "传输状态", width: 80, render: (row) => statusLabel(row.status) },
    {
      key: "fireAt",
      title: "到期 / 重试",
      width: 150,
      render: (row) => (
        <span className="lyx-cell-2">
          {at(row.fireAt)}
          <span className="lyx-cell-2__sub">
            {row.retryAt ? `重试 ${at(row.retryAt)}` : "无重试时间"}
          </span>
        </span>
      ),
    },
    {
      key: "error",
      title: "失败摘要",
      mask: true,
      render: (row) => (
        <span className="lyx-cell-2">
          {safeText(row.lastError)}
          <span className="lyx-cell-2__sub">
            失败 {row.attempts} 次 · 派发 {row.dispatchNo} 次
          </span>
          <span className="lyx-cell-2__sub">{safeSummary(row.result)}</span>
        </span>
      ),
    },
    {
      key: "actions",
      title: "操作",
      width: 190,
      render: (row) =>
        buttons([
          { kind: "reschedule", row },
          { kind: "cancel", row },
        ]),
    },
  ];
  const outboxColumns: QueryColumn<OutboxView>[] = [
    {
      key: "event",
      title: "事件 / 订阅者",
      width: 230,
      render: (row) => (
        <span className="lyx-cell-2">
          {safeText(row.event.eventType)}
          <span className="lyx-cell-2__sub">{safeText(row.subscriber)}</span>
          <span className="lyx-cell-2__sub" title={row.outboxEventId}>
            {row.outboxEventId.slice(-8)}
          </span>
        </span>
      ),
    },
    {
      key: "subject",
      title: "业务对象",
      width: 186,
      render: (row) => (
        <span className="lyx-cell-2">
          {safeText(row.event.aggregateType)}
          <span className="lyx-cell-2__sub" title={row.event.aggregateId ?? undefined}>
            {safeText(row.event.aggregateId)}
          </span>
        </span>
      ),
    },
    { key: "status", title: "传输状态", width: 80, render: (row) => statusLabel(row.status) },
    {
      key: "time",
      title: "更新 / 下次尝试",
      width: 150,
      render: (row) => (
        <span className="lyx-cell-2">
          {at(row.updatedAt)}
          <span className="lyx-cell-2__sub">{at(row.nextAttemptAt)}</span>
        </span>
      ),
    },
    {
      key: "error",
      title: "失败摘要",
      mask: true,
      render: (row) => (
        <span className="lyx-cell-2">
          {safeText(row.lastError)}
          <span className="lyx-cell-2__sub">
            失败 {row.attempts} 次 · 派发 {row.dispatchNo} 次
          </span>
        </span>
      ),
    },
    {
      key: "actions",
      title: "操作",
      width: 100,
      render: (row) => buttons([{ kind: "retry-outbox", row }]),
    },
  ];
  const webhookColumns: TableColumnsType<WebhookView> = [
    {
      key: "event",
      title: "来源 / 事件",
      width: 220,
      render: (_, row) => (
        <span className="lyx-cell-2">
          {row.provider} · {safeText(row.eventType)}
          <span className="lyx-cell-2__sub">{safeText(row.eventId)}</span>
        </span>
      ),
    },
    {
      key: "state",
      title: "传输状态",
      width: 90,
      render: (_, row) => statusLabel(row.processState),
    },
    {
      key: "time",
      title: "收件 / 下次尝试",
      width: 150,
      render: (_, row) => (
        <span className="lyx-cell-2">
          {at(row.receivedAt)}
          <span className="lyx-cell-2__sub">{at(row.nextAttemptAt)}</span>
        </span>
      ),
    },
    {
      key: "summary",
      title: "摘要 · 已脱敏",
      render: (_, row) => (
        <span className="lyx-cell-2">
          {safeText(row.error)}
          <span className="lyx-cell-2__sub">{safeSummary(row.summary)}</span>
          <span className="lyx-cell-2__sub">
            失败 {row.attempts} 次 · {row.payloadPurgedAt ? "载荷已清除" : "仅展示安全摘要"}
          </span>
        </span>
      ),
    },
    {
      key: "actions",
      title: "操作",
      width: 120,
      render: (_, row) => buttons([{ kind: "retry-webhook", row }]),
    },
  ];
  const filters = <FlowFilters key={JSON.stringify(search)} search={search} onChange={filter} />;
  const scope = cursorScope(search),
    previous = history.scope === scope ? history.previous : {};
  return (
    <>
      <PageHeader title="流程运维" subtitle="查询传输失败并恢复单个目标，业务到期时间保持原值" />
      {notice ? <Alert className="lyx-flow-notice" type="info" title={notice} /> : null}
      {tab === "timers" ? (
        <QueryTablePage
          label="流程运维列表"
          tabs={tabs}
          search={tableSearch(search)}
          onSearchChange={changeTable}
          columns={timerColumns}
          rowKey={(row) => row.timerId}
          query={queryState(timers)}
          refreshing={timers.isFetching}
          toolbar={filters}
          onRetry={() => void timers.refetch()}
          empty={{ title: "暂无失败的定时器", filteredTitle: "没有符合条件的定时器" }}
        />
      ) : null}
      {tab === "outbox" ? (
        <QueryTablePage
          label="流程运维列表"
          tabs={tabs}
          search={tableSearch(search)}
          onSearchChange={changeTable}
          columns={outboxColumns}
          rowKey={(row) => `${row.outboxEventId}:${row.subscriber}`}
          query={queryState(outbox)}
          refreshing={outbox.isFetching}
          toolbar={filters}
          onRetry={() => void outbox.refetch()}
          empty={{ title: "暂无死信投递", filteredTitle: "没有符合条件的投递" }}
        />
      ) : null}
      {tab === "webhooks" ? (
        <section className="lyx-card lyx-table-card" aria-label="流程运维列表">
          <Tabs
            label="流程运维列表的页签"
            items={tabs}
            activeKey={tab}
            onChange={(key) => {
              setHistory({ scope: "", previous: {} });
              change(flowSearch({ tab: key }));
            }}
          />
          <div className="lyx-filter-bar">{filters}</div>
          {webhooks.isPending ? (
            <p className="lyx-flow-loading" aria-busy="true">
              回调收件加载中
            </p>
          ) : webhooks.isError ? (
            <ErrorState message={webhooks.error.message} onRetry={() => void webhooks.refetch()} />
          ) : webhooks.data ? (
            <>
              {webhooks.data.items.length ? (
                <Table<WebhookView>
                  className="lyx-table"
                  tableLayout="fixed"
                  columns={webhookColumns}
                  dataSource={webhooks.data.items}
                  rowKey="webhookEventId"
                  pagination={false}
                  loading={webhooks.isFetching}
                />
              ) : (
                <EmptyState title="没有符合条件的回调收件" />
              )}
              <div className="lyx-flow-cursor-pager">
                <span>
                  共 {webhooks.data.totalApprox.toLocaleString("zh-CN")} 条
                  {webhooks.data.totalApprox >= 10000 ? "（最多显示 10,000 条）" : "（近似）"}
                </span>
                <Select
                  aria-label="每页条数"
                  value={Number(search.limit)}
                  options={[10, 20, 50, 100].map((value) => ({ value, label: `${value} 条` }))}
                  onChange={(value: number) => filter({ limit: String(value) })}
                />
                <Button
                  disabled={!search.cursor || !(search.cursor in previous) || webhooks.isFetching}
                  onClick={() => {
                    const next = { ...search };
                    if (previous[search.cursor!]) next.cursor = previous[search.cursor!]!;
                    else delete next.cursor;
                    change(next);
                  }}
                >
                  上一页
                </Button>
                <Button
                  disabled={
                    !webhooks.data.hasMore || !webhooks.data.nextCursor || webhooks.isFetching
                  }
                  onClick={() => {
                    const cursor = webhooks.data!.nextCursor!;
                    const stack = { ...previous, [cursor]: search.cursor };
                    if (Object.keys(stack).length > 1000) delete stack[Object.keys(stack)[0]!];
                    setHistory({ scope, previous: stack });
                    change({ ...search, cursor });
                  }}
                >
                  下一页
                </Button>
              </div>
            </>
          ) : null}
        </section>
      ) : null}
      {action ? (
        <FlowActionDialog
          key={`${action.kind}:${"timerId" in action.row ? action.row.timerId : "outboxEventId" in action.row ? `${action.row.outboxEventId}:${action.row.subscriber}` : "mediaJobId" in action.row ? action.row.mediaJobId : action.row.webhookEventId}`}
          action={action}
          access={access}
          api={api}
          refresh={refresh}
          onClose={() => setAction(undefined)}
          onDone={setNotice}
        />
      ) : null}
    </>
  );
}
