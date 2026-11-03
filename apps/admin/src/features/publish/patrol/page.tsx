import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Input } from "antd";
import { useCallback, useMemo, useState } from "react";
import { showSuccessNotice } from "../../../app/feedback";
import { PageHeader } from "../../../components/PageHeader";
import { MasterDetailPage } from "../../../components/MasterDetailPage";
import { QueryTablePage } from "../../../components/QueryTablePage";
import { StatusTag } from "../../../components/StatusTag";
import { useCan } from "../../../lib/permissions";
import { DETAIL_QUERY, QUEUE_QUERY } from "../../../lib/query";
import { writeTableSearch, type TableSearch } from "../../../lib/table-search";
import { createPatrolApi } from "./api";
import { PatrolDetails } from "./details";
import { MutationConfirm } from "./interaction";
import { isId, patrolQuery, patrolScope, patrolSearch, PATROL_KEY } from "./model";
import "./patrol.css";
const route = getRouteApi("/publish/patrol");
export function PatrolPage() {
  const { services } = useRouteContext({ from: "__root__" }),
    navigate = route.useNavigate(),
    search = patrolSearch(route.useSearch()),
    canDo = useCan("publish.patrol.do");
  const api = useMemo(() => createPatrolApi(services), [services]),
    [creating, setCreating] = useState(false),
    [launchId, setLaunchId] = useState(""),
    [reason, setReason] = useState("");
  const scope = patrolScope(search),
    list = useQuery({
      queryKey: [...PATROL_KEY, "list", patrolQuery(search)],
      queryFn: ({ signal }) => api.list(patrolQuery(search), signal),
      ...QUEUE_QUERY,
    });
  const summary = useQuery({
    queryKey: [...PATROL_KEY, "summary", scope],
    queryFn: ({ signal }) => api.summary(scope, signal),
    ...QUEUE_QUERY,
  });
  const id =
    !list.isPlaceholderData && list.data?.items.some((item) => item.patrolTaskId === search.id)
      ? search.id
      : !list.isPlaceholderData
        ? list.data?.items[0]?.patrolTaskId
        : undefined;
  const detail = useQuery({
    queryKey: [...PATROL_KEY, "detail", id],
    enabled: !!id,
    queryFn: ({ signal }) => api.detail(id!, signal),
    ...DETAIL_QUERY,
  });
  const current = detail.data?.patrolTaskId === id ? detail.data : undefined;
  const refresh = useCallback(() => {
    void services.queryClient.invalidateQueries({ queryKey: PATROL_KEY });
  }, [services]);
  const change = (next: TableSearch, selected?: string) =>
    void navigate({ search: { ...writeTableSearch(next), ...(selected ? { id: selected } : {}) } });
  const counts = !summary.isPlaceholderData ? summary.data : undefined;
  return (
    <>
      <PageHeader
        title="作品巡检"
        subtitle={
          counts
            ? `${counts.weekStartDate} 至 ${counts.weekEndDate} · 当前范围已巡检 ${counts.checked}`
            : "核查已上线作品与异常处理记录"
        }
        extra={
          canDo ? (
            <Button
              type="primary"
              onClick={() => {
                setLaunchId("");
                setReason("");
                setCreating(true);
              }}
            >
              手动发起巡检
            </Button>
          ) : undefined
        }
      />
      {counts?.batch ? (
        <Alert
          type="info"
          title={`本周全平台上线中 ${counts.batch.liveTotal} 部 · 抽查 ${counts.batch.sampledCount} 部`}
        />
      ) : counts ? (
        <Alert type="info" title="本周尚无抽查批次；手动巡检记录仍按当前筛选显示" />
      ) : null}
      {summary.isError ? (
        <Alert
          type="warning"
          title="巡检计数读取失败"
          action={<Button onClick={() => void summary.refetch()}>重试</Button>}
        />
      ) : null}
      <div className="lyx-lifecycle-filters">
        <label>
          巡检周一
          <Input
            type="date"
            aria-label="巡检周一"
            value={search.filters.weekStartDate ?? ""}
            onChange={(event) =>
              change(
                patrolSearch({
                  ...writeTableSearch(search),
                  weekStartDate: event.target.value,
                  page: 1,
                }),
              )
            }
          />
        </label>
      </div>
      <MasterDetailPage
        label="作品巡检"
        selectedKey={id}
        onSelect={(selected) => change(search, selected)}
        onRetry={() => void detail.refetch()}
        detailTitle="巡检详情"
        list={({ onSelect }) => (
          <QueryTablePage
            label="巡检队列"
            search={search}
            onSearchChange={(next) => change(next)}
            tabs={[
              { key: "all", label: "全部", count: counts?.all },
              { key: "pending", label: "待巡检", count: counts?.pending },
              { key: "abnormal", label: "异常", count: counts?.abnormal },
              { key: "normal", label: "正常 / 已恢复", count: counts?.normal },
            ]}
            keywordPlaceholder="搜索门店、账号、作品"
            filters={[
              {
                key: "source",
                placeholder: "全部来源",
                options: [
                  { value: "weekly_sample", label: "每周抽查" },
                  { value: "manual", label: "手动巡检" },
                  { value: "reissue", label: "补发巡检" },
                ],
              },
              {
                key: "openOnly",
                placeholder: "全部处理状态",
                options: [{ value: "true", label: "仅在办巡检" }],
              },
            ]}
            query={
              list.isPending || list.isPlaceholderData
                ? { status: "loading" }
                : list.isError
                  ? { status: "error", message: list.error.message }
                  : { status: "success", ...list.data }
            }
            onRetry={() => void list.refetch()}
            rowKey={(row) => row.patrolTaskId}
            selectedRowKey={id}
            onRowClick={(row) => onSelect(row.patrolTaskId)}
            rowTone={(row) => (row.status === "abnormal" ? "danger" : undefined)}
            columns={[
              {
                key: "work",
                title: "作品 / 门店",
                render: (row) => (
                  <>
                    {row.dramaTitle}
                    <br />
                    {row.store.storeName}
                  </>
                ),
              },
              { key: "account", title: "发布账号", render: (row) => row.account.accountName },
              {
                key: "status",
                title: "状态",
                width: 110,
                render: (row) => {
                  const tone = statusToneByEnum("patrol_task.status", row.status)?.admin;
                  return tone ? (
                    <StatusTag tone={tone.tone}>{tone.label}</StatusTag>
                  ) : row.status === "recovered" ? (
                    "已恢复"
                  ) : (
                    row.status
                  );
                },
              },
            ]}
            empty={{ title: "暂无巡检任务" }}
          />
        )}
        detail={
          id
            ? detail.isError
              ? { key: id, status: "error", message: detail.error.message }
              : current
                ? {
                    key: id,
                    status: "ready",
                    content: (
                      <PatrolDetails
                        key={`${id}:${current.status}:${current.checkedAt}:${current.recoveredAt}`}
                        detail={current}
                        api={api}
                        services={services}
                        canDo={canDo}
                        refresh={refresh}
                      />
                    ),
                  }
                : { key: id, status: "loading" }
            : undefined
        }
      />
      {creating ? (
        <MutationConfirm
          title="手动发起巡检"
          echo={[{ label: "上线任务", value: launchId || "尚未选择" }]}
          payload={{ launchTaskId: launchId, reason }}
          valid={isId(launchId) && reason.length <= 200}
          refresh={refresh}
          onClose={() => setCreating(false)}
          reconcile={() => api.list(patrolQuery(search))}
          send={async (key, signal) => {
            const result = await api.create(
              { launchTaskId: launchId, ...(reason.trim() ? { reason: reason.trim() } : {}) },
              key,
              signal,
            );
            if (!signal.aborted) {
              showSuccessNotice(result.isNew ? "已创建巡检任务" : "已定位现有在办巡检任务");
              change(
                {
                  ...search,
                  tab: "all",
                  page: 1,
                  q: result.patrolTask.account.accountName,
                  filters: { openOnly: "true", storeId: result.patrolTask.store.storeId },
                },
                result.patrolTask.patrolTaskId,
              );
            }
          }}
        >
          <label>
            上线任务编号
            <Input
              aria-label="上线任务编号"
              value={launchId}
              onChange={(event) => setLaunchId(event.target.value.trim())}
            />
          </label>
          <label>
            发起说明
            <Input.TextArea
              aria-label="发起说明"
              value={reason}
              maxLength={200}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        </MutationConfirm>
      ) : null}
    </>
  );
}
