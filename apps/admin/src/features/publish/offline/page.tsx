import { statusToneByEnum, statusToneByState } from "@liyoxi/shared/design/status-tone";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Checkbox, Input, Select, Space, Spin } from "antd";
import { useCallback, useMemo, useState } from "react";
import { showSuccessNotice } from "../../../app/feedback";
import { PageHeader } from "../../../components/PageHeader";
import { QueueWorkbench } from "../../../components/QueueWorkbench";
import { StatusTag } from "../../../components/StatusTag";
import { ErrorState } from "../../../components/StateBlock";
import { useCan } from "../../../lib/permissions";
import { DETAIL_QUERY, QUEUE_QUERY } from "../../../lib/query";
import { currentKey } from "../../../lib/queue";
import { createOfflineApi } from "./api";
import { OfflineBatchModal } from "./actions";
import { OfflineDetails } from "./details";
import { offlineScope, offlineSearch, OFFLINE_KEY } from "./model";
import "../patrol/patrol.css";
const route = getRouteApi("/publish/offline");
export function OfflinePage() {
  const { services } = useRouteContext({ from: "__root__" }),
    navigate = route.useNavigate(),
    search = offlineSearch(route.useSearch()),
    canCheck = useCan("publish.takedown.check"),
    canBreach = useCan("publish.takedown.breach_notice");
  const api = useMemo(() => createOfflineApi(services), [services]),
    [batch, setBatch] = useState(false),
    scope = offlineScope(search);
  const list = useInfiniteQuery({
    queryKey: [...OFFLINE_KEY, "list", scope, search.tab],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      api.list(
        {
          ...scope,
          tab: search.tab as "pending" | "waiting" | "checked",
          page: pageParam,
          pageSize: 100,
        },
        signal,
      ),
    getNextPageParam: (last) =>
      last.page * last.pageSize < last.total ? last.page + 1 : undefined,
    ...QUEUE_QUERY,
  });
  const summary = useQuery({
    queryKey: [...OFFLINE_KEY, "summary", scope],
    queryFn: ({ signal }) => api.summary(scope, signal),
    ...QUEUE_QUERY,
  });
  const rows = !list.isPlaceholderData
      ? (list.data?.pages.flatMap((page) => page.items) ?? [])
      : [],
    id = currentKey(
      rows.map((row) => row.takedownTaskId),
      search.id,
    );
  const detail = useQuery({
    queryKey: [...OFFLINE_KEY, "detail", id],
    enabled: !!id,
    queryFn: ({ signal }) => api.detail(id!, signal),
    ...DETAIL_QUERY,
  });
  const current = detail.data?.takedownTaskId === id ? detail.data : undefined,
    counts = !summary.isPlaceholderData ? summary.data : undefined;
  const refresh = useCallback(() => {
    void services.queryClient.invalidateQueries({ queryKey: OFFLINE_KEY });
  }, [services]);
  const change = (values: Partial<typeof search>) => {
    setBatch(false);
    void navigate({ search: { ...search, id: undefined, ...values } });
  };
  return (
    <>
      <PageHeader
        title="下架核查"
        subtitle="商家确认、后台核查与逾期跟进分别记录"
        extra={
          <Space>
            {canCheck ? (
              <Button
                onClick={() => setBatch(true)}
                disabled={!rows.some((row) => row.actions.includes("check"))}
              >
                批量核查
              </Button>
            ) : null}
            {list.hasNextPage ? (
              <Button loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                加载更多任务
              </Button>
            ) : null}
          </Space>
        }
      />
      {counts ? (
        <Alert
          type="info"
          title={`当前范围逾期 ${counts.overdue} · 今日截止 ${counts.dueToday} · 核查逾期 ${counts.checkOverdue}`}
        />
      ) : null}
      {summary.isError ? (
        <Alert
          type="warning"
          title="下架计数读取失败"
          action={<Button onClick={() => void summary.refetch()}>重试</Button>}
        />
      ) : null}
      <div className="lyx-lifecycle-filters">
        <Checkbox
          checked={search.isOverdue === "true"}
          onChange={(event) => change({ isOverdue: event.target.checked ? "true" : undefined })}
        >
          仅逾期任务
        </Checkbox>
        <Select
          aria-label="核查依据筛选"
          placeholder="全部核查依据"
          allowClear
          value={search.basis}
          options={[
            { value: "live", label: "已核验上线" },
            { value: "delivered_unverified", label: "已交付未核验上线" },
          ]}
          onChange={(basis) => change({ basis })}
        />
        <label>
          截止日起
          <Input
            type="date"
            aria-label="截止日起"
            value={search.dueFrom ?? ""}
            onChange={(event) => change({ dueFrom: event.target.value || undefined })}
          />
        </label>
        <label>
          截止日止
          <Input
            type="date"
            aria-label="截止日止"
            value={search.dueTo ?? ""}
            onChange={(event) => change({ dueTo: event.target.value || undefined })}
          />
        </label>
      </div>
      <QueueWorkbench
        label="下架核查"
        search={search}
        onSearchChange={(next) => change(next)}
        tabs={[
          { key: "pending", label: "待核查", count: counts?.pending },
          { key: "waiting", label: "等待商家", count: counts?.waiting },
          { key: "checked", label: "已核查", count: counts?.checked },
        ]}
        searchPlaceholder="搜索门店、作品、账号"
        queue={
          list.isPending || list.isPlaceholderData
            ? { status: "loading" }
            : list.isError
              ? { status: "error", message: list.error.message }
              : { status: "success", items: rows }
        }
        onRetry={() => void list.refetch()}
        onQueueChanged={refresh}
        notifySuccess={showSuccessNotice}
        itemKey={(row) => row.takedownTaskId}
        renderItem={(row) => {
          const label =
            row.status === "merchant_confirmed"
              ? "待核查"
              : row.isOverdue && row.status === "pending_merchant"
                ? "逾期未下架"
                : "等待商家";
          const tone =
            statusToneByEnum("takedown_task.status", String(row.status))?.admin ??
            statusToneByState("task-queue", label)?.admin;
          return {
            title: row.dramaTitle,
            line: `${row.store.storeName ?? "未命名门店"} · ${row.account.accountName}`,
            meta: `${row.dueDate} 截止${row.isOverdue ? ` · 逾期 ${row.overdueDays ?? "—"} 天` : ""}`,
            tag: tone ? <StatusTag tone={tone.tone}>{tone.label}</StatusTag> : label,
          };
        }}
        detailHeader={(row) => ({
          title: row.account.accountName,
          description: `${row.dramaTitle} · ${row.orderNo}`,
        })}
        detail={() =>
          detail.isError ? (
            <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />
          ) : current ? (
            <OfflineDetails
              key={`${id}:${current.status}:${current.checkedAt}:${current.stillOnlineCount}:${current.escalatedAt}`}
              detail={current}
              api={api}
              services={services}
              canCheck={canCheck}
              canBreach={canBreach}
              refresh={refresh}
            />
          ) : (
            <Spin />
          )
        }
        actions={[]}
        readOnlyHint={!canCheck && !canBreach ? "当前权限仅可查看下架记录" : undefined}
        empty={{ title: "暂无下架任务" }}
      />
      {batch && canCheck ? (
        <OfflineBatchModal
          rows={rows}
          api={api}
          services={services}
          refresh={refresh}
          close={() => setBatch(false)}
        />
      ) : null}
    </>
  );
}
