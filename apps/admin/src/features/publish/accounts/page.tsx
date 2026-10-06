import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
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
import { createAccountsApi } from "./api";
import { AccountDetails, type Controller } from "./details";
import { accountSearch, ACCOUNTS_KEY } from "./model";
import "./accounts.css";
const route = getRouteApi("/publish/accounts");
export function AccountsPage() {
  const { services } = useRouteContext({ from: "__root__" }),
    navigate = route.useNavigate(),
    search = accountSearch(route.useSearch()),
    canVerify = useCan("publish.account.verify");
  const api = useMemo(() => createAccountsApi(services), [services]),
    controllers = useRef(new Map<string, Controller>());
  const register = useCallback((id: string, controller: Controller | null) => {
    if (controller) controllers.current.set(id, controller);
    else controllers.current.delete(id);
  }, []);
  const list = useInfiniteQuery({
    queryKey: [...ACCOUNTS_KEY, "list", search.tab, search.q],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      api.list(search.tab === "done_today" ? "done_today" : "todo", search.q, pageParam),
    getNextPageParam: (last) =>
      last.page * last.pageSize < last.total ? last.page + 1 : undefined,
    ...QUEUE_QUERY,
  });
  const summary = useQuery({
    queryKey: [...ACCOUNTS_KEY, "summary", search.q],
    queryFn: () => api.summary(search.q),
    ...QUEUE_QUERY,
  });
  const templates = useQuery({
    queryKey: [...ACCOUNTS_KEY, "template"],
    queryFn: api.templates,
    ...DICT_QUERY,
  });
  const items = list.data?.pages.flatMap((page) => page.items) ?? [],
    selected = items.find(
      (item) =>
        item.approvalId ===
        currentKey(
          items.map((row) => row.approvalId),
          search.id,
        ),
    ),
    id = selected?.domain.id;
  const detail = useQuery({
    queryKey: [...ACCOUNTS_KEY, "detail", id],
    enabled: Boolean(id) && !list.isPlaceholderData,
    queryFn: () => api.detail(id!),
    ...DETAIL_QUERY,
  });
  const current =
    !list.isPlaceholderData && detail.data?.channelAccountSubmissionId === id
      ? detail.data
      : undefined;
  const refresh = () => {
    void services.queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
  };
  const checklist = [
    ...(templates.data?.items
      .filter((item) => item.required)
      .map((item) => ({ key: item.key, label: item.label })) ?? []),
    ...(current?.approval.confirmChecks.map((code) => ({ key: `confirm:${code}`, label: code })) ??
      []),
  ];
  return (
    <>
      <PageHeader
        title="账号核验"
        subtitle="人工核对主页截图、账号资料与认证主体"
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
        label="账号核验"
        tabs={[
          { key: "todo", label: "待核验", count: summary.data?.todo },
          { key: "done_today", label: "今日已核验", count: summary.data?.doneToday },
        ]}
        search={search}
        onSearchChange={(next) => void navigate({ search: writeQueueSearch(next) })}
        searchPlaceholder="搜索门店、账号名称"
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
              "主页截图待核对",
            meta: `${date.dateTime(row.submittedAt)} 提交`,
            tag: tone ? <StatusTag tone={tone.tone}>{tone.label}</StatusTag> : row.status,
          };
        }}
        detailHeader={(row) => ({
          title: current?.filled.accountName ?? row.summary.title,
          description: current
            ? `第 ${current.roundNo} 轮 · ${current.isCurrentRound ? "当前轮次" : "历史轮次"}`
            : undefined,
        })}
        detail={() =>
          detail.isError ? (
            <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />
          ) : templates.isError ? (
            <ErrorState
              message={templates.error.message}
              onRetry={() => void templates.refetch()}
            />
          ) : current && !templates.isPending ? (
            <AccountDetails
              key={current.channelAccountSubmissionId}
              detail={current}
              api={api}
              template={templates.data}
              canVerify={canVerify}
              refresh={refresh}
              register={register}
            />
          ) : (
            <Spin />
          )
        }
        checklist={current && checklist.length ? { items: checklist } : undefined}
        actions={
          current && canVerify && !templates.isPending && !templates.isError
            ? [
                {
                  key: "reject",
                  label: "驳回",
                  kind: "reject",
                  hidden: !current.actions.includes("reject"),
                  run: () =>
                    controllers.current.get(current.channelAccountSubmissionId)?.reject() ??
                    Promise.resolve({ outcome: "failed", message: "详情仍在加载，请稍后重试" }),
                },
                {
                  key: "approve",
                  label: "通过",
                  kind: "primary",
                  needsChecklist: true,
                  hidden: !current.actions.includes("approve"),
                  run: ({ checked }) =>
                    controllers.current.get(current.channelAccountSubmissionId)?.approve(checked) ??
                    Promise.resolve({ outcome: "failed", message: "详情仍在加载，请稍后重试" }),
                },
              ]
            : []
        }
        readOnlyHint={
          !canVerify
            ? "当前权限仅可查看账号核验资料"
            : current && !current.actions.length && current.approval.status === "pending"
              ? "当前事项暂不可处理，请刷新核对"
              : undefined
        }
        settled={
          current?.approval.status === "approved"
            ? () => ({ tone: "success", message: "账号已通过核验" })
            : current?.approval.status === "rejected"
              ? () => ({ tone: "danger", message: "账号已驳回，请商家补正" })
              : undefined
        }
        empty={{ title: "暂无待核验账号" }}
      />
    </>
  );
}
