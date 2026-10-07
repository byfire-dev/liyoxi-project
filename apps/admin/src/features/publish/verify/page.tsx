import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Spin } from "antd";
import { useCallback, useMemo, useRef } from "react";
import { showSuccessNotice } from "../../../app/feedback";
import { PageHeader } from "../../../components/PageHeader";
import { QueueWorkbench } from "../../../components/QueueWorkbench";
import { ErrorState } from "../../../components/StateBlock";
import { StatusTag } from "../../../components/StatusTag";
import { useCan } from "../../../lib/permissions";
import { DETAIL_QUERY, DICT_QUERY, QUEUE_QUERY } from "../../../lib/query";
import { currentKey, writeQueueSearch } from "../../../lib/queue";
import { createVerifyApi } from "./api";
import { VerifyDetails, type Controller } from "./details";
import { verifySearch, VERIFY_KEY } from "./model";
import "./verify.css";
const route = getRouteApi("/publish/verify");
export function VerifyPage() {
  const { services } = useRouteContext({ from: "__root__" }),
    navigate = route.useNavigate(),
    search = verifySearch(route.useSearch()),
    canVerify = useCan("publish.link.verify");
  const api = useMemo(() => createVerifyApi(services), [services]),
    controllers = useRef(new Map<string, Controller>());
  const register = useCallback((id: string, controller: Controller | null) => {
    if (controller) controllers.current.set(id, controller);
    else controllers.current.delete(id);
  }, []);
  const refresh = useCallback(() => {
    void services.queryClient.invalidateQueries({ queryKey: VERIFY_KEY });
  }, [services]);
  const list = useInfiniteQuery({
    queryKey: [...VERIFY_KEY, "list", search.tab, search.q],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      api.list(search.tab === "done_today" ? "done_today" : "todo", search.q, pageParam),
    getNextPageParam: (last) =>
      last.page * last.pageSize < last.total ? last.page + 1 : undefined,
    ...QUEUE_QUERY,
  });
  const summary = useQuery({
    queryKey: [...VERIFY_KEY, "summary", search.q],
    queryFn: () => api.summary(search.q),
    ...QUEUE_QUERY,
  });
  const template = useQuery({
    queryKey: [...VERIFY_KEY, "template"],
    queryFn: api.template,
    ...DICT_QUERY,
  });
  const items = list.data?.pages.flatMap((page) => page.items) ?? [],
    selected = items.find(
      (row) =>
        row.approvalId ===
        currentKey(
          items.map((item) => item.approvalId),
          search.id,
        ),
    ),
    id = selected?.domain.id;
  const detail = useQuery({
    queryKey: [...VERIFY_KEY, "detail", id],
    enabled: !!id && !list.isPlaceholderData,
    queryFn: () => api.detail(id!),
    ...DETAIL_QUERY,
  });
  const current =
    !list.isPlaceholderData && detail.data?.launchSubmissionId === id ? detail.data : undefined;
  const ready = current && template.data;
  return (
    <>
      <PageHeader
        title="链接核验"
        subtitle="核对商家上线链接与实际可播放集数"
        extra={
          list.hasNextPage ? (
            <Button loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              加载更多事项
            </Button>
          ) : undefined
        }
      />
      {summary.isError ? <Alert type="warning" title="页签计数暂未刷新" /> : null}
      <QueueWorkbench
        key={`${id ?? "empty"}:${current?.approval.lockVersion ?? "loading"}:${current?.roundNo ?? "loading"}:${template.data?.versionNo ?? "loading"}`}
        label="链接核验"
        tabs={[
          { key: "todo", label: "待核验", count: summary.data?.todo },
          { key: "done_today", label: "今日已核验", count: summary.data?.doneToday },
        ]}
        search={search}
        onSearchChange={(next) => void navigate({ search: writeQueueSearch(next) })}
        searchPlaceholder="搜索门店、账号、短剧"
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
        itemKey={(row) => row.approvalId}
        renderItem={(row) => {
          const tone = statusToneByEnum("approval_request.status", row.status)?.admin;
          return {
            title: row.summary.title,
            line:
              row.summary.lines?.map((line) => `${line.label}：${line.value}`).join(" · ") ||
              "上线链接待核对",
            meta: `${date.dateTime(row.submittedAt)} 提交`,
            tag: tone ? <StatusTag tone={tone.tone}>{tone.label}</StatusTag> : row.status,
          };
        }}
        detailHeader={(row) => ({
          title: current?.account.accountName ?? row.summary.title,
          description: current
            ? `第 ${current.roundNo} 轮 · ${current.isCurrentRound ? "当前轮次" : "历史轮次"}`
            : undefined,
        })}
        detail={() =>
          detail.isError ? (
            <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />
          ) : template.isError ? (
            <ErrorState message={template.error.message} onRetry={() => void template.refetch()} />
          ) : ready ? (
            <VerifyDetails
              key={`${current.launchSubmissionId}:${current.approval.lockVersion}:${current.roundNo}:${ready.versionNo}`}
              detail={current}
              api={api}
              template={template.data}
              canVerify={canVerify}
              refresh={refresh}
              register={register}
            />
          ) : template.isSuccess && !template.data ? (
            <ErrorState message="链接核验模板未配置" onRetry={() => void template.refetch()} />
          ) : (
            <Spin />
          )
        }
        checklist={
          ready && current.approval.status === "pending"
            ? {
                items: [
                  ...ready.items.map((item) => ({ key: item.key, label: item.label })),
                  ...current.approval.confirmChecks.map((code) => ({
                    key: `confirm:${code}`,
                    label: code,
                  })),
                ],
              }
            : undefined
        }
        actions={
          ready && canVerify
            ? [
                {
                  key: "reject",
                  label: "退回修改",
                  kind: "reject",
                  hidden: !current.actions.includes("reject"),
                  run: () =>
                    controllers.current.get(current.launchSubmissionId)?.reject() ??
                    Promise.resolve({ outcome: "failed", message: "详情仍在加载，请稍后重试" }),
                },
                {
                  key: "approve",
                  label: "核验通过",
                  kind: "primary",
                  needsChecklist: true,
                  hidden: !current.actions.includes("approve"),
                  run: ({ checked }) =>
                    controllers.current.get(current.launchSubmissionId)?.approve(checked) ??
                    Promise.resolve({ outcome: "failed", message: "详情仍在加载，请稍后重试" }),
                },
              ]
            : []
        }
        readOnlyHint={!canVerify ? "当前权限仅可查看链接核验资料" : undefined}
        settled={
          current?.approval.status === "approved"
            ? () => ({ tone: "success", message: "链接已通过核验" })
            : current?.approval.status === "rejected"
              ? () => ({ tone: "danger", message: "链接已退回修改" })
              : undefined
        }
        empty={{ title: search.tab === "done_today" ? "今日暂无已核验链接" : "暂无待核验链接" }}
      />
    </>
  );
}
