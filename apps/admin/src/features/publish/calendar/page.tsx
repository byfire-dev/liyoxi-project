import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useRouteContext } from "@tanstack/react-router";
import { Alert, Button } from "antd";
import { useContext, useMemo } from "react";
import { MasterDetailPage } from "../../../components/MasterDetailPage";
import { MonthSwitcher } from "../../../components/MonthSwitcher";
import { PageHeader } from "../../../components/PageHeader";
import { EmptyState, ErrorState, FullPageNotice } from "../../../components/StateBlock";
import { StatusTag } from "../../../components/StatusTag";
import { AccessContext, hasModuleLevel } from "../../../lib/permissions";
import { LIST_QUERY } from "../../../lib/query";
import { actorScope } from "../../system/staff-access";
import { createCalendarApi, type CalendarItem } from "./api";
import { ManagerFilter, VerifyLink } from "./controls";
import { CalendarOverduePanel } from "./overdue-panel";
import {
  CALENDAR_KEY,
  calendarDays,
  calendarKinds,
  calendarQuery,
  calendarSearch,
  dayLabel,
  selectedDate,
  verifyingTasks,
} from "./model";
import "./calendar.css";

const route = getRouteApi("/publish/calendar");
export function CalendarPage() {
  const access = useContext(AccessContext);
  if (!hasModuleLevel(access, "publish"))
    return <FullPageNotice title="没有查看权限" description="请联系管理员开通发布管理查看权限" />;
  return <CalendarWorkspace key={actorScope(access)} />;
}
function CalendarWorkspace() {
  const { services } = useRouteContext({ from: "__root__" }),
    access = useContext(AccessContext);
  const search = calendarSearch(route.useSearch()),
    navigate = route.useNavigate(),
    scope = actorScope(access);
  const api = useMemo(() => createCalendarApi(services), [services]);
  const query = useQuery({
    queryKey: [...CALENDAR_KEY, scope, calendarQuery(search)],
    queryFn: ({ signal }) => api.get(calendarQuery(search), signal),
    ...LIST_QUERY,
  });
  const data = !query.isPlaceholderData && !query.isError ? query.data : undefined;
  const selected = data ? selectedDate(data, search.date) : search.date;
  const days = data ? calendarDays(data) : [],
    current = days.find((day) => day.date === selected);
  const change = (patch: Partial<typeof search>) =>
    void navigate({ search: { ...search, ...patch } });
  const unimported = data?.workCalendar.years.filter((year) => year.importedAt === null) ?? [];
  return (
    <>
      <PageHeader
        title="上线日历"
        subtitle="按约定上线日期查看交付事项与账号核验"
        extra={
          <Link to="/publish/overdue" search={{ tab: "overdue" }}>
            逾期跟进
          </Link>
        }
      />
      <div className="lyx-launch-toolbar">
        <MonthSwitcher
          value={{ year: Number(search.month.slice(0, 4)), month: Number(search.month.slice(5)) }}
          onChange={(next) =>
            change({
              month: `${String(next.year).padStart(4, "0")}-${String(next.month).padStart(2, "0")}`,
              date: undefined,
            })
          }
        />
        <ManagerFilter
          api={api}
          value={search.managerId}
          onChange={(managerId) => change({ managerId })}
        />
        <Button onClick={() => void query.refetch()} loading={query.isFetching}>
          刷新日历
        </Button>
      </div>
      {query.isError ? (
        <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
      ) : !data ? (
        <div className="lyx-state" aria-busy="true">
          日历加载中
        </div>
      ) : (
        <>
          <div className="lyx-launch-stats" aria-label="当前视图统计">
            <strong>当前视图 {data.stats.total} 项</strong>
            {Object.entries(calendarKinds).map(([kind, item]) => (
              <span key={kind} className={`lyx-calendar-kind lyx-calendar-kind--${kind}`}>
                {item.label}{" "}
                {
                  data.stats[
                    (
                      {
                        producing: "producing",
                        to_launch: "toLaunch",
                        verifying: "verifying",
                        overdue: "overdue",
                      } as const
                    )[kind as keyof typeof calendarKinds]
                  ]
                }
              </span>
            ))}
          </div>
          {unimported.length ? (
            <Alert
              type="warning"
              title={`${unimported.map((year) => year.year).join("、")} 年节假日安排尚未导入`}
              description="已存工作日照常展示；缺少的日历不作推定，请联系管理员核对。"
            />
          ) : null}
          {data.isTruncated ? (
            <Alert type="warning" title="当前日历事项未全部返回，请缩小筛选范围后查看" />
          ) : null}
          <MasterDetailPage
            label="上线月历"
            selectedKey={selected}
            onSelect={(value) => change({ date: value })}
            detailTitle="当日上线安排"
            onRetry={() => void query.refetch()}
            list={() => (
              <section className="lyx-card lyx-launch-month" aria-label={`${search.month} 月历`}>
                <div className="lyx-launch-weekdays" aria-hidden="true">
                  {["一", "二", "三", "四", "五", "六", "日"].map((day) => (
                    <span key={day}>{day}</span>
                  ))}
                </div>
                <div className="lyx-launch-grid">
                  {Array.from(
                    { length: (new Date(`${data.from}T00:00:00Z`).getUTCDay() + 6) % 7 },
                    (_, index) => (
                      <div key={`blank-${index}`} aria-hidden="true" />
                    ),
                  )}
                  {days.map((day) => (
                    <button
                      key={day.date}
                      type="button"
                      className={`lyx-launch-day${day.date === selected ? " is-selected" : ""}`}
                      aria-label={day.date}
                      aria-pressed={day.date === selected}
                      onClick={() => change({ date: day.date })}
                    >
                      <span className="lyx-launch-day-heading">
                        <strong>{Number(day.date.slice(8))}</strong>
                        {day.date === data.today ? <span>今天</span> : null}
                      </span>
                      <span className="lyx-launch-day-fact">{dayLabel(day)}</span>
                      {day.items.map((item) => (
                        <span
                          key={item.orderItemId}
                          className={`lyx-calendar-kind lyx-calendar-kind--${item.calendarStatus}`}
                        >
                          {item.store.storeName} ·{" "}
                          {item.isDateTentative
                            ? "待确认"
                            : calendarKinds[item.calendarStatus].label}
                        </span>
                      ))}
                    </button>
                  ))}
                </div>
                {data.stats.total === 0 ? (
                  <EmptyState title="本月暂无上线安排" description="可切换月份或清除经理筛选" />
                ) : null}
              </section>
            )}
            detail={{
              key: selected!,
              status: "ready",
              content: (
                <div
                  className="lyx-launch-details"
                  key={`${scope}:${search.month}:${search.managerId}:${selected}`}
                >
                  <p>
                    {selected} · {current ? dayLabel(current) : "缺少日历"}
                  </p>
                  {current?.items.length ? (
                    current.items.map((item) => (
                      <CalendarCard key={item.orderItemId} item={item} api={api} />
                    ))
                  ) : (
                    <EmptyState title="当日暂无上线安排" />
                  )}
                </div>
              ),
            }}
          />
        </>
      )}
      <CalendarOverduePanel services={services} managerId={search.managerId} />
    </>
  );
}
function CalendarCard({
  item,
  api,
}: {
  item: CalendarItem;
  api: ReturnType<typeof createCalendarApi>;
}) {
  const access = useContext(AccessContext),
    kind = calendarKinds[item.calendarStatus];
  return (
    <article className="lyx-launch-item">
      <h3>{item.store.storeName ?? "未命名门店"}</h3>
      <p>
        {item.dramaTitle} · {item.episodeCount} 集
      </p>
      <StatusTag tone={kind.tone}>{kind.label}</StatusTag>
      {item.isDateTentative ? <StatusTag tone="neutral">上线日期待确认</StatusTag> : null}
      <p>交付经理：{item.ticket.deliveryManager?.name ?? "未分派"}</p>
      {item.isDeliveryLate ? (
        <p className="lyx-launch-warning">
          成片应于 {date.dateTime(item.ticket.deliveryTargetAt)} 交付，已超时
        </p>
      ) : null}
      {item.overdueDays !== null ? (
        <p className="lyx-launch-warning">上线已逾期 {item.overdueDays} 天</p>
      ) : null}
      <ul>
        {item.accounts.map((account) => (
          <li key={account.channelAccountId}>
            {account.platform === "douyin" ? "抖音" : "视频号"} · {account.accountName}
          </li>
        ))}
      </ul>
      {item.latestFollowUp ? (
        <p>
          最近跟进：{item.latestFollowUp.content} · {date.dateTime(item.latestFollowUp.createdAt)}
        </p>
      ) : null}
      {hasModuleLevel(access, "delivery") ? (
        <Link
          to="/delivery/tickets/$ticketNo"
          params={{ ticketNo: item.ticket.ticketNo }}
          search={{ tab: "sample" }}
        >
          查看工单 {item.ticket.ticketNo}
        </Link>
      ) : null}
      {verifyingTasks(item.tasks).map((task) => (
        <VerifyLink
          key={task.currentSubmissionId!}
          api={api}
          submissionId={task.currentSubmissionId!}
          accountName={task.account.accountName}
        />
      ))}
      {item.calendarStatus === "overdue" ? (
        <Link to="/publish/overdue" search={{ tab: "overdue", orderItemId: item.orderItemId }}>
          查看逾期与跟进
        </Link>
      ) : null}
    </article>
  );
}
