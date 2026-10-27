import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Button, Input, Skeleton, Table, type TableProps } from "antd";
import { useContext, useMemo, useState } from "react";
import { formatSignedPercent } from "@liyoxi/shared/format/money";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { PageHeader } from "../../../components/PageHeader";
import { MasterDetailPage } from "../../../components/MasterDetailPage";
import { InfoList } from "../../../components/InfoList";
import { Tabs } from "../../../components/Tabs";
import { ErrorState } from "../../../components/StateBlock";
import { AccessContext, canAction } from "../../../lib/permissions";
import { LIST_QUERY, DETAIL_QUERY } from "../../../lib/query";
import { showSuccessNotice } from "../../../app/feedback";
import { billingScope, moneyText, pointsText } from "../../billing/plans/model";
import { BillingConfirm } from "../../billing/plans/confirm";
import { renewalSearch, renewalFilters } from "./model";
import { createRenewalsApi, type TermRow, type TermDetail } from "./api";
import { ExtensionDialog } from "./extension";
import "../../billing/plans/billing.css";
const route = getRouteApi("/orders/renewals");
const intents: Record<string, string> = {
  none: "未跟进",
  considering: "考虑中",
  confirmed: "已确认",
  declined: "暂不续费",
  renewed: "已续费",
  extension_pending: "延长待审",
};
const statuses: Record<string, string> = {
  scheduled: "待生效",
  active: "生效中",
  ended: "已结束",
  refunded: "已退款",
  cancelled: "已取消",
};
export function RenewalsPage() {
  return <RenewalsWorkspace key={billingScope(useContext(AccessContext))} />;
}
function RenewalsWorkspace() {
  const { services } = useRouteContext({ from: "__root__" }),
    access = useContext(AccessContext),
    scope = billingScope(access),
    search = renewalSearch(route.useSearch()),
    navigate = route.useNavigate(),
    api = useMemo(() => createRenewalsApi(services), [services]),
    filters = renewalFilters(search);
  const list = useQuery({
      queryKey: ["order", scope, "terms", search],
      queryFn: ({ signal }) =>
        api.list(
          { ...filters, tab: search.tab, page: search.page, pageSize: search.pageSize },
          signal,
        ),
      ...LIST_QUERY,
    }),
    summary = useQuery({
      queryKey: ["order", scope, "term-summary", filters],
      queryFn: ({ signal }) => api.summary(filters, signal),
      ...DETAIL_QUERY,
    }),
    detail = useQuery({
      queryKey: ["order", scope, "term", search.termId],
      queryFn: ({ signal }) => api.detail(search.termId!, signal),
      enabled: !!search.termId,
      ...DETAIL_QUERY,
    });
  const [remind, setRemind] = useState<TermRow>(),
    [extension, setExtension] = useState<TermDetail>();
  const change = (patch: Record<string, unknown>) =>
    void navigate({ search: renewalSearch({ ...search, ...patch }) });
  const refresh = () => {
    void list.refetch();
    void summary.refetch();
    if (search.termId) void detail.refetch();
  };
  const columns: NonNullable<TableProps<TermRow>["columns"]> = [
    {
      key: "entity",
      title: "主体 / 套餐",
      render: (_, r) => (
        <span>
          <strong>{r.entity.name}</strong>
          <br />
          {r.plan.name} · {r.months}个月
          <br />
          {r.entity.primaryStoreName ?? "无主门店"}
        </span>
      ),
    },
    {
      key: "date",
      title: "周期 / 到期",
      render: (_, r) => (
        <span>
          {r.startDate} 至 {r.endDate}
          <br />
          {statuses[r.status] ?? r.status} ·{" "}
          {r.remainingDays !== null
            ? `剩余${r.remainingDays}天`
            : r.expiredDays !== null
              ? `过期${r.expiredDays}天`
              : "—"}
        </span>
      ),
    },
    {
      key: "points",
      title: "积分",
      render: (_, r) => (
        <span>
          套餐 {r.points.planAvailablePoints}
          <br />
          加购 {r.points.addonAvailablePoints}
          {r.points.isAddonSuspended ? "（暂停）" : ""}
          <br />
          最近清零 {r.points.lastExpiredPoints ?? "—"}
        </span>
      ),
    },
    {
      key: "reminders",
      title: "提醒 / 意向",
      render: (_, r) => (
        <span>
          {r.reminders
            .map(
              (n) =>
                `${n.node}：${n.state === "sent" ? "已发" : n.state === "pending" ? "待发" : "跳过"}`,
            )
            .join("；") || "暂无提醒"}
          <br />
          {intents[r.intent] ?? r.intent}
        </span>
      ),
    },
    { key: "manager", title: "交付经理", render: (_, r) => r.manager?.name ?? "未分配" },
    {
      key: "actions",
      title: "操作",
      render: (_, r) => (
        <div className="billing-actions">
          <Button size="small" onClick={() => change({ termId: r.subscriptionTermId })}>
            详情
          </Button>
          {canAction(access, "order.renewal.remind") && r.actions.includes("remind") ? (
            <Button
              size="small"
              disabled={r.remindedToday}
              onClick={() => setRemind(structuredClone(r))}
            >
              {r.remindedToday ? "今日已提醒" : "补发提醒"}
            </Button>
          ) : null}
        </div>
      ),
    },
  ];
  const row = detail.data;
  return (
    <div className="billing-stack">
      <PageHeader title="套餐到期" subtitle="到期分类、清零预告及续费金额均由服务端提供。" />
      {summary.isError ? (
        <ErrorState onRetry={() => void summary.refetch()} />
      ) : (
        <section className="lyx-card billing-panel billing-kpis">
          <span>
            7天内到期 <strong>{summary.data?.expiring ?? "—"}</strong>
          </span>
          <span>已过期 {summary.data?.expired ?? "—"}</span>
          <span>
            本月续费 {summary.data?.renewed ?? "—"} · {moneyText(summary.data?.renewedFen)}
          </span>
          <span>提前续费 {summary.data?.renewedAheadCount ?? "—"}</span>
          <span>
            {summary.data?.renewalRate.month ?? "本月"}续费率{" "}
            {summary.data?.renewalRate.rateBp == null
              ? "—"
              : formatSignedPercent(summary.data.renewalRate.rateBp).replace(/^\+/, "")}
            {summary.data?.renewalRate.isProvisional ? "（未结月）" : ""}
          </span>
        </section>
      )}
      <MasterDetailPage
        label="到期跟进"
        selectedKey={search.termId}
        onSelect={(termId) => change({ termId })}
        onRetry={() => void detail.refetch()}
        list={() => (
          <section className="lyx-card billing-panel billing-stack">
            <Tabs
              label="到期分类"
              activeKey={search.tab}
              items={[
                { key: "expiring", label: "7天内到期", count: summary.data?.expiring },
                { key: "expired", label: "已过期未续费", count: summary.data?.expired },
                { key: "renewed", label: "本月已续费", count: summary.data?.renewed },
              ]}
              onChange={(tab) => change({ tab, page: 1 })}
            />
            <div className="billing-actions">
              <Input.Search
                aria-label="搜索到期主体"
                defaultValue={search.q}
                placeholder="主体或门店"
                onSearch={(q) => change({ q, page: 1 })}
              />
              <Input.Search
                aria-label="筛选交付经理ID"
                defaultValue={search.managerId}
                placeholder="交付经理ID（选填）"
                onSearch={(managerId) => change({ managerId, page: 1 })}
              />
              <Input.Search
                aria-label="筛选套餐ID"
                defaultValue={search.planId}
                placeholder="套餐ID（选填）"
                onSearch={(planId) => change({ planId, page: 1 })}
              />
              <Button
                onClick={() =>
                  change({ q: undefined, managerId: undefined, planId: undefined, page: 1 })
                }
              >
                重置筛选
              </Button>
            </div>
            {list.isPending ? (
              <Skeleton active />
            ) : list.isError ? (
              <ErrorState onRetry={refresh} />
            ) : (
              <div className="billing-table">
                <Table<TermRow>
                  rowKey="subscriptionTermId"
                  columns={columns}
                  dataSource={list.data.items}
                  pagination={{
                    current: search.page,
                    pageSize: search.pageSize,
                    total: list.data.total,
                    showSizeChanger: true,
                    pageSizeOptions: [10, 20, 50],
                    onChange: (page, pageSize) => change({ page, pageSize }),
                  }}
                  locale={{ emptyText: "暂无符合条件的周期" }}
                />
              </div>
            )}
          </section>
        )}
        detail={
          search.termId
            ? detail.isPending
              ? { key: search.termId, status: "loading" }
              : detail.isError
                ? { key: search.termId, status: "error", message: detail.error.message }
                : row
                  ? {
                      key: row.subscriptionTermId,
                      status: "ready",
                      content: (
                        <div className="billing-stack">
                          <h3>
                            {row.entity.name} · {row.plan.name}
                          </h3>
                          <InfoList
                            items={[
                              { label: "本期", value: `${row.startDate} 至 ${row.endDate}` },
                              {
                                label: "清零时间",
                                value: appDateTimeFormat.dateTimeFull(row.pointsForecast.expiresAt),
                              },
                              {
                                label: "预告清零",
                                value: pointsText(row.pointsForecast.planPointsToExpire),
                              },
                              {
                                label: "加购积分",
                                value: row.pointsForecast.addonWillSuspend
                                  ? "到期暂停使用"
                                  : "保持可用",
                              },
                              {
                                label: "正在制作 / 待上线 / 在播",
                                value: `${row.orderItems.producingCount} / ${row.orderItems.toLaunchCount} / ${row.orderItems.liveCount}`,
                              },
                              { label: "下次投放", value: row.orderItems.nextLaunchDate ?? "无" },
                              {
                                label: "后续周期",
                                value: row.nextTerm
                                  ? `${row.nextTerm.planName} · ${row.nextTerm.startDate} 至 ${row.nextTerm.endDate} · ${row.nextTerm.orderNo} · ${moneyText(row.nextTerm.amountFen)}`
                                  : "无",
                              },
                              {
                                label: "最近跟进",
                                value: row.latestFollowUp
                                  ? `${row.latestFollowUp.owner.name} · ${row.latestFollowUp.content}`
                                  : "无",
                              },
                            ]}
                          />
                          {row.reminders.map((n) => (
                            <p key={n.node}>
                              {n.node} · {n.dueDate} · {n.state}
                              <br />
                              {n.channels
                                .map(
                                  (c) =>
                                    `${c.channel}：${c.status}${c.sentAt ? ` · ${appDateTimeFormat.dateTimeFull(c.sentAt)}` : ""}`,
                                )
                                .join("；")}
                            </p>
                          ))}
                          {row.extensions.map((e) => (
                            <p key={e.termExtensionRequestId}>
                              {e.requestNo} · 已延长{e.days}天 ·{" "}
                              {appDateTimeFormat.dateTimeFull(e.appliedAt)}
                            </p>
                          ))}
                          {row.pendingExtension ? (
                            <p>
                              待审：{row.pendingExtension.requestNo} · {row.pendingExtension.days}天
                              · {row.pendingExtension.requester.name}
                            </p>
                          ) : null}
                          {canAction(access, "billing.extension.request") &&
                          row.actions.includes("create-term-extension-request") ? (
                            <Button onClick={() => setExtension(structuredClone(row))}>
                              发起补偿延长
                            </Button>
                          ) : null}
                        </div>
                      ),
                    }
                  : undefined
            : undefined
        }
      />
      {remind ? (
        <BillingConfirm
          action="renewal-remind"
          spec={{
            title: "补发续费提醒",
            echo: [
              { label: "主体", value: remind.entity.name },
              { label: "套餐", value: remind.plan.name },
              { label: "到期日", value: remind.endDate },
            ],
            checkLabel: "已核对主体，确认补发订阅消息及短信",
          }}
          submit={(key, signal) => api.remind(remind.subscriptionTermId, key, signal)}
          onClose={() => setRemind(undefined)}
          onSaved={() => {
            setRemind(undefined);
            showSuccessNotice("续费提醒已提交");
            refresh();
          }}
          onConflict={refresh}
        />
      ) : null}
      {extension ? (
        <ExtensionDialog
          key={extension.subscriptionTermId}
          row={extension}
          api={api}
          scope={scope}
          onClose={() => setExtension(undefined)}
          onSaved={(no) => {
            showSuccessNotice(`延长申请已提交${no ? `：${no}` : ""}，审批后生效`);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}
