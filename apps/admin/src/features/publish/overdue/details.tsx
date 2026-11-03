import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "antd";
import { useContext, useState } from "react";
import { EmptyState, ErrorState } from "../../../components/StateBlock";
import { StatusTag } from "../../../components/StatusTag";
import { AccessContext, hasModuleLevel } from "../../../lib/permissions";
import { LIST_QUERY } from "../../../lib/query";
import { actorScope } from "../../system/staff-access";
import type { CalendarApi } from "../calendar/api";
import { VerifyLink } from "../calendar/controls";
import { verifyingTasks } from "../calendar/model";
import type { OverdueApi, TrackItem } from "./api";
import { FollowAction } from "./actions";
import { OVERDUE_KEY, canRemind, overdueLabel } from "./model";

export function TrackDetails({
  row,
  api,
  calendarApi,
  refresh,
}: {
  row: TrackItem;
  api: OverdueApi;
  calendarApi: CalendarApi;
  refresh(): Promise<void>;
}) {
  const access = useContext(AccessContext),
    [action, setAction] = useState<"follow" | "remind">();
  const [historyOpen, setHistoryOpen] = useState(false);
  const history = useInfiniteQuery({
    queryKey: [...OVERDUE_KEY, actorScope(access), "follows", row.orderItem.orderItemId],
    enabled: historyOpen,
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => api.follows(row.orderItem.orderItemId, pageParam, signal),
    getNextPageParam: (last) =>
      last.page * last.pageSize < last.total ? last.page + 1 : undefined,
    ...LIST_QUERY,
  });
  const records = historyOpen
    ? (history.data?.pages.flatMap((page) => page.items) ?? [])
    : row.followUps;
  const reload = async () => {
    await refresh();
    if (historyOpen) {
      const result = await history.refetch();
      if (result.error) throw result.error;
    }
  };
  return (
    <div className="lyx-overdue-details">
      <h3>{row.store.storeName ?? "未命名门店"}</h3>
      <p>
        {row.orderItem.dramaTitle} · {row.orderItem.episodeCount} 集
      </p>
      <p className={row.overdue ? "lyx-launch-warning" : undefined}>{overdueLabel(row)}</p>
      {row.overdue ? (
        <p>
          逾期起算：{row.overdue.startDate}
          {row.overdue.reason === "late_delivery" ? " · 成片晚交，单独记录，不计为商家逾期" : ""}
        </p>
      ) : null}
      <p>约定上线：{row.orderItem.agreedLaunchDate ?? "尚未确认"}</p>
      <p>
        交付经理：{row.ticket.deliveryManager?.name ?? "未分派"} · 发布专员：
        {row.ticket.publisher?.name ?? "未分派"}
      </p>
      {row.ticket.isPaused ? <StatusTag tone="warning">工单已暂停</StatusTag> : null}
      <section aria-label="各账号上线任务">
        <h3>各账号上线任务</h3>
        {row.tasks.length ? (
          row.tasks.map((task) => {
            const status = statusToneByEnum("launch_task.review_status", task.reviewStatus)?.admin;
            return (
              <article className="lyx-overdue-task" key={task.launchTaskId}>
                <strong>
                  {task.platform === "douyin" ? "抖音" : "视频号"} · {task.account.accountName}
                </strong>
                <div>
                  <StatusTag tone={task.isLive ? "success" : "neutral"}>
                    {task.isLive ? "已上线" : "未上线"}
                  </StatusTag>
                  {status ? <StatusTag tone={status.tone}>{status.label}</StatusTag> : null}
                  {task.isOverdue ? <StatusTag tone="danger">该账号逾期</StatusTag> : null}
                </div>
                <p>
                  已核验 {task.verifiedEpisodeCount} / {row.orderItem.episodeCount} 集 · 第{" "}
                  {task.currentRoundNo} 轮
                </p>
                {verifyingTasks([task]).map((current) => (
                  <VerifyLink
                    key={current.currentSubmissionId!}
                    api={calendarApi}
                    submissionId={current.currentSubmissionId!}
                    accountName={current.account.accountName}
                  />
                ))}
              </article>
            );
          })
        ) : (
          <EmptyState title="成片尚未推送，暂无上线任务" />
        )}
      </section>
      {hasModuleLevel(access, "delivery") ? (
        <Link
          to="/delivery/tickets/$ticketNo"
          params={{ ticketNo: row.ticket.ticketNo }}
          search={{ tab: "sample" }}
        >
          查看工单 {row.ticket.ticketNo}
        </Link>
      ) : null}
      <div className="lyx-overdue-action-buttons">
        <Button onClick={() => setAction("follow")}>记录跟进</Button>
        {hasModuleLevel(access, "delivery") && canRemind(row) ? (
          <Button onClick={() => setAction("remind")}>提醒商家上线</Button>
        ) : row.isRemindedToday ? (
          <Button disabled>今天已提醒</Button>
        ) : null}
      </div>
      {row.lastRemindedAt ? <p>最近提醒：{date.dateTime(row.lastRemindedAt)}</p> : null}
      <section aria-label="跟进记录">
        <h3>跟进记录 · {row.followUpCount} 条</h3>
        {historyOpen && history.isError ? (
          <ErrorState message={history.error.message} onRetry={() => void history.refetch()} />
        ) : historyOpen && history.isPending ? (
          <p aria-busy="true">跟进记录加载中</p>
        ) : records.length ? (
          records.map((follow) => (
            <article key={follow.followUpId} className="lyx-overdue-task">
              <p>{follow.content}</p>
              <small>
                {follow.recorder.staff?.name ?? "系统"} · {date.dateTime(follow.createdAt)}
              </small>
              {follow.nextFollowAt ? (
                <p>
                  下次跟进：{date.dateTime(follow.nextFollowAt)} ·{" "}
                  {follow.isOpen ? "待跟进" : "已结束"}
                </p>
              ) : null}
            </article>
          ))
        ) : (
          <EmptyState title="暂无跟进记录" />
        )}
        {!historyOpen && row.followUpCount > row.followUps.length ? (
          <Button onClick={() => setHistoryOpen(true)}>查看全部跟进</Button>
        ) : null}
        {history.hasNextPage ? (
          <Button loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
            加载更多跟进
          </Button>
        ) : null}
      </section>
      {action ? (
        <FollowAction
          key={`${row.orderItem.orderItemId}:${action}`}
          row={row}
          api={api}
          kind={action}
          close={() => setAction(undefined)}
          refresh={reload}
        />
      ) : null}
    </div>
  );
}
