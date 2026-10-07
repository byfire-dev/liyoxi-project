import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Spin } from "antd";
import { useCallback, useMemo, useRef, useState } from "react";
import { showSuccessNotice } from "../../../app/feedback";
import { PageHeader } from "../../../components/PageHeader";
import { QueueWorkbench } from "../../../components/QueueWorkbench";
import { ErrorState } from "../../../components/StateBlock";
import { useCan } from "../../../lib/permissions";
import { DETAIL_QUERY, DICT_QUERY, QUEUE_QUERY } from "../../../lib/query";
import { currentKey, writeQueueSearch } from "../../../lib/queue";
import { createDeliveriesApi } from "./api";
import { DeliveryDetails, ReleaseFacts, type Controller, type Release } from "./details";
import { deliverySearch, DELIVERIES_KEY } from "./model";
import "./deliveries.css";
const route = getRouteApi("/publish/deliveries");
export function DeliveriesPage() {
  const { services } = useRouteContext({ from: "__root__" }),
    navigate = route.useNavigate(),
    search = deliverySearch(route.useSearch()),
    canPush = useCan("publish.package.push");
  const api = useMemo(() => createDeliveriesApi(services), [services]),
    controllers = useRef(new Map<string, Controller>());
  const [released, setReleased] = useState<Release>();
  const register = useCallback((id: string, controller: Controller | null) => {
    if (controller) controllers.current.set(id, controller);
    else controllers.current.delete(id);
  }, []);
  const refresh = useCallback(() => {
    void services.queryClient.invalidateQueries({ queryKey: DELIVERIES_KEY });
  }, [services]);
  const list = useInfiniteQuery({
    queryKey: [...DELIVERIES_KEY, "list", search.tab, search.q],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      api.list(
        search.tab === "delivered_today" ? "delivered_today" : "delivering",
        search.q,
        pageParam,
      ),
    getNextPageParam: (last) =>
      last.page * last.pageSize < last.total ? last.page + 1 : undefined,
    ...QUEUE_QUERY,
  });
  const summary = useQuery({
    queryKey: [...DELIVERIES_KEY, "summary", search.q],
    queryFn: () => api.summary(search.q),
    ...QUEUE_QUERY,
  });
  const template = useQuery({
    queryKey: [...DELIVERIES_KEY, "template"],
    queryFn: api.template,
    ...DICT_QUERY,
  });
  const items = list.data?.pages.flatMap((page) => page.items) ?? [],
    id = currentKey(
      items.map((row) => row.deliveryTicketId),
      search.id,
    );
  const detail = useQuery({
    queryKey: [...DELIVERIES_KEY, "detail", id],
    enabled: !!id && !list.isPlaceholderData,
    queryFn: () => api.detail(id!),
    ...DETAIL_QUERY,
  });
  const grid = useQuery({
    queryKey: [...DELIVERIES_KEY, "episodes", id],
    enabled: !!id && !list.isPlaceholderData,
    queryFn: () => api.episodes(id!),
    ...DETAIL_QUERY,
  });
  const current =
      !list.isPlaceholderData && detail.data?.deliveryTicketId === id ? detail.data : undefined,
    releaseId = current?.release?.deliveryReleaseId;
  const release = useQuery({
    queryKey: [...DELIVERIES_KEY, "release", releaseId],
    enabled: !!releaseId,
    queryFn: () => api.release(releaseId!),
    ...DETAIL_QUERY,
  });
  const ready = current && grid.data && !grid.isPlaceholderData && template.data;
  return (
    <>
      <PageHeader
        title="成片交付"
        subtitle="核对成片与发布清单，推送给商家"
        extra={
          list.hasNextPage ? (
            <Button loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              加载更多工单
            </Button>
          ) : undefined
        }
      />
      {summary.isError ? <Alert type="warning" title="页签计数暂未刷新" /> : null}
      {released ? (
        <div className="lyx-delivery-notice">
          <Alert
            type="success"
            title={`${released.orderItem.dramaTitle} 成片包已推送`}
            closable
            afterClose={() => setReleased(undefined)}
          />
          <ReleaseFacts release={released} />
        </div>
      ) : null}
      <QueueWorkbench
        key={`${id ?? "empty"}:${current?.lockVersion ?? "loading"}:${template.data?.versionNo ?? "loading"}`}
        label="成片交付"
        tabs={[
          { key: "delivering", label: "待交付", count: summary.data?.tabs.delivering },
          {
            key: "delivered_today",
            label: "今日已交付",
            count: summary.data?.tabs.delivered_today,
          },
        ]}
        search={search}
        onSearchChange={(next) => void navigate({ search: writeQueueSearch(next) })}
        searchPlaceholder="搜索工单、门店、短剧"
        queue={
          list.isPending || list.isPlaceholderData
            ? { status: "loading" }
            : list.isError
              ? { status: "error", message: list.error.message }
              : { status: "success", items }
        }
        onRetry={() => void list.refetch()}
        onQueueChanged={refresh}
        notifySuccess={showSuccessNotice}
        itemKey={(row) => row.deliveryTicketId}
        renderItem={(row) => ({
          title: `${row.store.storeName ?? "未命名门店"} · ${row.dramaTitle}`,
          line: `${row.episodeCount} 集 · ${row.ticketNo}`,
          meta: row.deliveredAt
            ? `${date.dateTime(row.deliveredAt)} 已交付`
            : `${date.dateTime(row.deliveryTargetAt)} 前交付`,
        })}
        detailHeader={(row) => ({
          title: current?.dramaTitle ?? row.dramaTitle,
          description: `${row.ticketNo} · ${row.order.orderNo}`,
        })}
        detail={() => {
          const failed = detail.isError
            ? detail
            : grid.isError
              ? grid
              : template.isError
                ? template
                : release.isError
                  ? release
                  : null;
          return failed ? (
            <ErrorState message={failed.error?.message} onRetry={() => void failed.refetch()} />
          ) : ready ? (
            <DeliveryDetails
              key={`${current.deliveryTicketId}:${current.lockVersion}:${ready.versionNo}`}
              detail={current}
              grid={grid.data}
              api={api}
              template={template.data}
              canPush={canPush}
              refresh={refresh}
              register={register}
              onReleased={setReleased}
              release={release.data?.deliveryReleaseId === releaseId ? release.data : undefined}
            />
          ) : template.isSuccess && !template.data ? (
            <ErrorState message="交付前检查模板未配置" onRetry={() => void template.refetch()} />
          ) : (
            <Spin />
          );
        }}
        checklist={
          ready && current.actions.includes("push-package")
            ? {
                title: "交付前检查",
                items: [
                  ...ready.items.map((item) => ({ key: item.key, label: item.label })),
                  ...(current.orderItem.accounts.some((account) => account.status === "abnormal")
                    ? [{ key: "ack:abnormal", label: "已核对异常账号，确认仍向商家推送成片包" }]
                    : []),
                ],
              }
            : undefined
        }
        actions={
          ready && canPush
            ? [
                {
                  key: "push",
                  label: "推送给商家",
                  kind: "primary",
                  needsChecklist: true,
                  hidden: !current.actions.includes("push-package"),
                  run: ({ checked }) =>
                    controllers.current.get(current.deliveryTicketId)?.(checked) ??
                    Promise.resolve({ outcome: "failed", message: "详情仍在加载，请稍后重试" }),
                },
              ]
            : []
        }
        settled={
          current?.release ? () => ({ tone: "success", message: "成片包已推送给商家" }) : undefined
        }
        readOnlyHint={!canPush ? "当前权限仅可查看成片交付资料" : undefined}
        empty={{
          title: search.tab === "delivered_today" ? "今日暂无已交付工单" : "暂无待交付工单",
        }}
      />
    </>
  );
}
