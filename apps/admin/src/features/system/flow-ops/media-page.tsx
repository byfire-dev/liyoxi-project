import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button } from "antd";
import { useState } from "react";
import { PageHeader } from "../../../components/PageHeader";
import {
  QueryTablePage,
  type QueryColumn,
  type QueryState,
} from "../../../components/QueryTablePage";
import { StatusTag } from "../../../components/StatusTag";
import { Tabs } from "../../../components/Tabs";
import type { AccessSnapshot } from "../../../lib/permissions";
import { LIST_QUERY } from "../../../lib/query";
import { readTableSearch } from "../../../lib/table-search";
import { createFlowOpsApi, type MediaView } from "./api";
import { FlowActionDialog } from "./actions";
import { FLOW_KEY, TABS, actorKey, flowSearch, safeText, type FlowAction } from "./model";
import { canReadMedia, canRetryMedia, mediaQuery, mediaSearch } from "./media-model";
import { MediaFilters } from "./media-filters";
const route = getRouteApi("/sys/flow-ops");
const at = (value: string | null) => (value ? appDateTimeFormat.dateTimeFull(value) : "—");
export function MediaJobsTab({ access }: { access: AccessSnapshot | null }) {
  const { services } = useRouteContext({ from: "__root__" }),
    navigate = route.useNavigate(),
    search = mediaSearch(route.useSearch()),
    api = createFlowOpsApi(services),
    identity = actorKey(access),
    allowed = canReadMedia(access);
  const [action, setAction] = useState<FlowAction>(),
    [notice, setNotice] = useState<string>();
  const jobs = useQuery({
    queryKey: [...FLOW_KEY, identity, "media", mediaQuery(search)],
    queryFn: () => api.media(mediaQuery(search)),
    enabled: allowed,
    ...LIST_QUERY,
    placeholderData: undefined,
  });
  const change = (next: Record<string, unknown>) => {
    setAction(undefined);
    setNotice(undefined);
    void navigate({ search: flowSearch(next) });
  };
  const refresh = () =>
    services.queryClient.invalidateQueries({ queryKey: [...FLOW_KEY, identity, "media"] });
  const columns: QueryColumn<MediaView>[] = [
    {
      key: "job",
      title: "任务 / 种类",
      width: 165,
      render: (row) => (
        <span className="lyx-cell-2">
          {row.kind}
          <span className="lyx-cell-2__sub" title={row.mediaJobId}>
            {row.mediaJobId.slice(-12)}
          </span>
          <span className="lyx-cell-2__sub">
            {safeText(row.provider)} · {row.mode}
          </span>
        </span>
      ),
    },
    {
      key: "state",
      title: "任务状态",
      width: 120,
      render: (row) => {
        const side = statusToneByEnum("media_job.state", row.state)?.admin;
        return (
          <span className="lyx-cell-2">
            {side ? <StatusTag tone={side.tone}>{side.label}</StatusTag> : "未识别状态"}
            <span className="lyx-cell-2__sub">
              已尝试 {row.attemptNo} / {row.maxAttempts}
            </span>
          </span>
        );
      },
    },
    {
      key: "subject",
      title: "对象 / 父对象",
      width: 185,
      render: (row) => (
        <span className="lyx-cell-2">
          {row.subject.type}
          <span className="lyx-cell-2__sub" title={row.subject.id}>
            {row.subject.id.slice(-12)}
          </span>
          <span className="lyx-cell-2__sub">
            {row.parent ? `${row.parent.type} · ${row.parent.id.slice(-8)}` : "无父对象"}
          </span>
        </span>
      ),
    },
    {
      key: "error",
      title: "失败摘要",
      render: (row) => (
        <span className="lyx-cell-2">
          {row.error ? safeText(row.error.code) : "—"}
          <span className="lyx-cell-2__sub">
            {row.error
              ? row.error.isRetryable
                ? "上次失败允许自动重试"
                : "上次失败不自动重试"
              : "无失败记录"}
          </span>
        </span>
      ),
    },
    {
      key: "time",
      title: "下次执行 / 截止",
      width: 175,
      render: (row) => (
        <span className="lyx-cell-2">
          {at(row.nextRunAt)}
          <span className="lyx-cell-2__sub">{at(row.deadlineAt)}</span>
          <span className="lyx-cell-2__sub">完成 {at(row.finishedAt)}</span>
        </span>
      ),
    },
    {
      key: "actions",
      title: "操作",
      width: 100,
      render: (row) =>
        canRetryMedia(access, row) ? (
          <Button type="link" onClick={() => setAction({ kind: "retry-media", row })}>
            重试任务
          </Button>
        ) : null,
    },
  ];
  const query: QueryState<MediaView> = jobs.isPending
    ? { status: "loading" }
    : jobs.isError
      ? { status: "error", message: jobs.error.message }
      : { status: "success", items: jobs.data?.items ?? [], total: jobs.data?.total ?? 0 };
  return (
    <>
      <PageHeader
        title="流程运维"
        subtitle="查询媒体任务并恢复单个失败任务；父对象由任务进程推进"
      />
      {!allowed ? (
        <>
          <Tabs
            label="流程运维列表的页签"
            items={TABS.filter((tab) => tab.key !== "media")}
            activeKey=""
            onChange={(tab) => change({ tab })}
          />
          <Alert type="info" title="媒体任务需要系统查看权限，其他流程运维资源仍可访问。" />
        </>
      ) : (
        <>
          {notice ? <Alert className="lyx-flow-notice" type="info" title={notice} /> : null}
          <QueryTablePage
            label="媒体任务列表"
            tabs={TABS}
            search={readTableSearch(search)}
            onSearchChange={(next) =>
              change(
                next.tab !== "media"
                  ? { tab: next.tab }
                  : { ...search, page: next.page, pageSize: next.pageSize },
              )
            }
            columns={columns}
            rowKey={(row) => row.mediaJobId}
            query={query}
            refreshing={jobs.isFetching}
            onRetry={() => void jobs.refetch()}
            toolbar={
              <MediaFilters
                key={JSON.stringify(search)}
                search={search}
                onChange={(patch) => change({ ...search, ...patch, page: 1 })}
              />
            }
            empty={{ title: "暂无失败的媒体任务", filteredTitle: "没有符合条件的媒体任务" }}
          />
          {action ? (
            <FlowActionDialog
              key={"mediaJobId" in action.row ? action.row.mediaJobId : "media"}
              action={action}
              access={access}
              api={api}
              refresh={refresh}
              onClose={() => setAction(undefined)}
              onDone={setNotice}
            />
          ) : null}
        </>
      )}
    </>
  );
}
