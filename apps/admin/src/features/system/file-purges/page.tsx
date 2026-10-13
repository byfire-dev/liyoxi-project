import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button } from "antd";
import { useContext, useState } from "react";
import { PageHeader } from "../../../components/PageHeader";
import {
  QueryTablePage,
  type QueryColumn,
  type QueryState,
} from "../../../components/QueryTablePage";
import { StatusTag } from "../../../components/StatusTag";
import { EmptyState } from "../../../components/StateBlock";
import { AccessContext, type AccessSnapshot } from "../../../lib/permissions";
import { LIST_QUERY } from "../../../lib/query";
import { readTableSearch, type TableSearch } from "../../../lib/table-search";
import { createPurgeApi, type FileView, type RunView } from "./api";
import { PurgeActionDialog, purgeActionTitle } from "./actions";
import { PurgeFilters } from "./filters";
import {
  PURGE_KEY,
  PURGE_TABS,
  byteCount,
  fileQuery,
  fileTableSearch,
  purgeActionAllowed,
  purgeActorKey,
  purgeSearch,
  runLabels,
  runQuery,
  safePurgeText,
  textLabel,
  type PurgeAction,
} from "./model";
import "./file-purges.css";
const route = getRouteApi("/sys/file-purges");
const at = (value: string | null) => (value ? appDateTimeFormat.dateTimeFull(value) : "—");
function state<Row>(query: {
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
export function MediaOpsStatus({ column, value }: { column: string; value: string }) {
  const side = statusToneByEnum(column, value)?.admin;
  return side ? <StatusTag tone={side.tone}>{side.label}</StatusTag> : <span>未识别状态</span>;
}
export function FilePurgesPage() {
  const access = useContext(AccessContext);
  return <FilePurgesContent key={purgeActorKey(access)} access={access} />;
}
function FilePurgesContent({ access }: { access: AccessSnapshot | null }) {
  const { services } = useRouteContext({ from: "__root__" }),
    navigate = route.useNavigate(),
    search = purgeSearch(route.useSearch()),
    api = createPurgeApi(services),
    identity = purgeActorKey(access),
    runsTab = search.tab === "runs";
  const [action, setAction] = useState<PurgeAction>(),
    [notice, setNotice] = useState<string>();
  const runs = useQuery({
    queryKey: [...PURGE_KEY, identity, "runs", runQuery(search)],
    queryFn: () => api.runs(runQuery(search)),
    enabled: runsTab,
    ...LIST_QUERY,
    placeholderData: undefined,
  });
  const files = useQuery({
    queryKey: [...PURGE_KEY, identity, "files", fileQuery(search)],
    queryFn: () => api.files(fileQuery(search)),
    enabled: !runsTab || Boolean(search.purgeRunId),
    ...LIST_QUERY,
    placeholderData: undefined,
  });
  const refresh = () =>
    services.queryClient.invalidateQueries({ queryKey: [...PURGE_KEY, identity] });
  const change = (next: Record<string, unknown>) => {
    setAction(undefined);
    setNotice(undefined);
    void navigate({ search: purgeSearch(next) });
  };
  const buttons = (choices: PurgeAction[]) => (
    <span className="lyx-purge-actions">
      {choices
        .filter((item) => purgeActionAllowed(access, item))
        .map((item) => (
          <Button
            key={item.kind}
            type="link"
            danger={item.kind === "erase" || item.kind === "reject"}
            onClick={() => setAction(item)}
          >
            {purgeActionTitle(item.kind)}
          </Button>
        ))}
    </span>
  );
  const runColumns: QueryColumn<RunView>[] = [
    {
      key: "run",
      title: "清除运行",
      width: 170,
      render: (row) => (
        <span className="lyx-cell-2" title={row.purgeRunId}>
          {row.purgeRunId.slice(-12)}
          <span className="lyx-cell-2__sub">{row.mode === "auto" ? "自动模式" : "清单模式"}</span>
        </span>
      ),
    },
    {
      key: "state",
      title: "运行状态",
      width: 145,
      render: (row) => <MediaOpsStatus column="file_purge_run.state" value={row.state} />,
    },
    {
      key: "count",
      title: "候选 / 已清除",
      width: 135,
      align: "right",
      render: (row) => (
        <span className="lyx-cell-2">
          {row.candidateCount} / {row.deletedCount ?? "—"}
          <span className="lyx-cell-2__sub">{byteCount(row.candidateBytes)}</span>
        </span>
      ),
    },
    {
      key: "guard",
      title: "熔断 / 守卫",
      render: (row) => (
        <span className="lyx-cell-2">
          {safePurgeText(row.heldReason)}
          <span className="lyx-cell-2__sub">守卫拒绝 {row.guardTrips ?? 0} 次</span>
        </span>
      ),
    },
    {
      key: "time",
      title: "生成 / 完成",
      width: 170,
      render: (row) => (
        <span className="lyx-cell-2">
          {at(row.createdAt)}
          <span className="lyx-cell-2__sub">{at(row.finishedAt)}</span>
        </span>
      ),
    },
    {
      key: "actions",
      title: "操作",
      width: 120,
      render: (row) =>
        buttons([
          { kind: "approve", row },
          { kind: "reject", row },
        ]),
    },
  ];
  const fileColumns: QueryColumn<FileView>[] = [
    {
      key: "file",
      title: "文件 / 分类",
      render: (row) => (
        <span className="lyx-cell-2">
          {safePurgeText(row.originalName)}
          <span className="lyx-cell-2__sub" title={row.fileId}>
            {safePurgeText(row.category)} · {row.fileId.slice(-12)}
          </span>
        </span>
      ),
    },
    {
      key: "status",
      title: "文件状态",
      width: 125,
      render: (row) => (
        <span className="lyx-cell-2">
          <MediaOpsStatus column="file_object.status" value={row.status} />
          <span className="lyx-cell-2__sub">
            {row.erasedAt ? "已彻底删除" : `在用引用 ${row.liveRefCount}`}
          </span>
        </span>
      ),
    },
    {
      key: "bytes",
      title: "大小",
      width: 145,
      align: "right",
      render: (row) => byteCount(row.sizeBytes),
    },
    {
      key: "scope",
      title: "归属 / 上传人",
      width: 175,
      render: (row) => (
        <span className="lyx-cell-2">
          {row.scopeType} · {row.storeId?.slice(-8) ?? row.entityId?.slice(-8) ?? "平台"}
          <span className="lyx-cell-2__sub">{safePurgeText(row.uploader.label)}</span>
        </span>
      ),
    },
    {
      key: "time",
      title: "清除 / 可恢复截止",
      width: 180,
      render: (row) => (
        <span className="lyx-cell-2">
          {at(row.deletedAt)}
          <span className="lyx-cell-2__sub">
            {row.restorableUntil ? at(row.restorableUntil) : "不可恢复"}
          </span>
          <span className="lyx-cell-2__sub">可清除 {at(row.purgeAfter)}</span>
        </span>
      ),
    },
    {
      key: "actions",
      title: "操作",
      width: 145,
      render: (row) =>
        buttons([
          { kind: "restore", row },
          { kind: "erase", row },
        ]),
    },
  ];
  const picked = runs.data?.items.find((row) => row.purgeRunId === search.purgeRunId);
  const fileChange = (next: TableSearch) => {
    if (!runsTab && next.tab !== "files") {
      change({ tab: next.tab });
      return;
    }
    change({
      ...search,
      ...(runsTab
        ? { filePage: next.page, filePageSize: next.pageSize }
        : { page: next.page, pageSize: next.pageSize }),
    });
  };
  const fileFilters = (
    <PurgeFilters
      key={`files:${JSON.stringify(search)}`}
      search={search}
      kind="files"
      onChange={(patch) =>
        change({ ...search, ...patch, ...(runsTab ? { filePage: 1 } : { page: 1 }) })
      }
    />
  );
  return (
    <>
      <PageHeader
        title="文件清除放行"
        subtitle="先核对候选与保留限制；放行后的执行结果以任务进程实际状态为准"
      />
      {notice ? <Alert className="lyx-purge-detail" type="info" title={notice} /> : null}
      {runsTab ? (
        <>
          <QueryTablePage
            label="清除运行列表"
            tabs={PURGE_TABS}
            search={readTableSearch(search)}
            onSearchChange={(next) =>
              change(
                next.tab !== "runs"
                  ? { tab: next.tab }
                  : { ...search, page: next.page, pageSize: next.pageSize },
              )
            }
            columns={runColumns}
            rowKey={(row) => row.purgeRunId}
            selectedRowKey={search.purgeRunId}
            onRowClick={(row) => change({ ...search, purgeRunId: row.purgeRunId, filePage: 1 })}
            query={state(runs)}
            refreshing={runs.isFetching}
            onRetry={() => void runs.refetch()}
            toolbar={
              <PurgeFilters
                key={`runs:${JSON.stringify(search)}`}
                search={search}
                kind="runs"
                onChange={(patch) =>
                  change({ ...search, ...patch, page: 1, purgeRunId: undefined })
                }
              />
            }
            empty={{ title: "暂无待处理的清除运行", filteredTitle: "没有符合条件的清除运行" }}
          />
          <section className="lyx-purge-section" aria-label="清除运行候选明细">
            <h2>候选明细</h2>
            {search.purgeRunId ? (
              <>
                <div className="lyx-card lyx-purge-summary">
                  <p>运行 ID：{search.purgeRunId}</p>
                  {picked ? (
                    <>
                      <p>
                        {textLabel(runLabels, picked.state)} · {picked.candidateCount} 个文件 ·{" "}
                        {byteCount(picked.candidateBytes)}
                      </p>
                      {picked.heldReason ? (
                        <p>熔断原因：{safePurgeText(picked.heldReason, 500)}</p>
                      ) : null}
                      <p>
                        按分类：
                        {Object.entries(picked.byCategory)
                          .map(
                            ([category, value]) =>
                              `${safePurgeText(category)} ${value.count} 个 / ${byteCount(value.bytes)}`,
                          )
                          .join("；")}
                      </p>
                    </>
                  ) : (
                    <p>该运行已不在当前筛选结果中；候选仍按服务端当前事实展示。</p>
                  )}
                </div>
                <QueryTablePage
                  label="候选文件列表"
                  search={fileTableSearch(search)}
                  onSearchChange={fileChange}
                  columns={fileColumns}
                  rowKey={(row) => row.fileId}
                  query={state(files)}
                  refreshing={files.isFetching}
                  onRetry={() => void files.refetch()}
                  toolbar={fileFilters}
                  empty={{ title: "暂无可见候选文件", filteredTitle: "没有符合条件的候选文件" }}
                />
              </>
            ) : (
              <EmptyState
                title="请选择一条清除运行"
                description="点击运行行查看候选分类、保留窗口与实际可用动作。"
              />
            )}
          </section>
        </>
      ) : (
        <QueryTablePage
          label="已清除文件列表"
          tabs={PURGE_TABS}
          search={{ ...fileTableSearch(search), tab: "files" }}
          onSearchChange={fileChange}
          columns={fileColumns}
          rowKey={(row) => row.fileId}
          query={state(files)}
          refreshing={files.isFetching}
          onRetry={() => void files.refetch()}
          toolbar={fileFilters}
          empty={{ title: "暂无已清除文件", filteredTitle: "没有符合条件的文件" }}
        />
      )}
      {action ? (
        <PurgeActionDialog
          key={`${action.kind}:${"fileId" in action.row ? action.row.fileId : action.row.purgeRunId}`}
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
