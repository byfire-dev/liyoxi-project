import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Input, Select, Skeleton, Table, type TableProps } from "antd";
import { useContext, useMemo, useState } from "react";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { PageHeader } from "../../../components/PageHeader";
import { MasterDetailPage } from "../../../components/MasterDetailPage";
import { InfoList } from "../../../components/InfoList";
import { Tabs } from "../../../components/Tabs";
import { DateRangeField } from "../../../components/DateRangeField";
import { EmptyState, ErrorState } from "../../../components/StateBlock";
import { AccessContext, canAction } from "../../../lib/permissions";
import { DETAIL_QUERY, LIST_QUERY } from "../../../lib/query";
import { showSuccessNotice } from "../../../app/feedback";
import { billingScope, pointsText } from "../plans/model";
import { createPlansApi } from "../plans/api";
import { createAccountsApi, type AccountDetail, type AccountRow } from "./api";
import { accountFilters, accountSearch, ledgerQuery } from "./model";
import { AdjustmentDialog } from "./adjustment";
import "../plans/billing.css";
const route = getRouteApi("/billing/accounts");
const subStatus = { none: "未开通", active: "生效中", expired: "已到期" };
export function AccountsPage() {
  return <AccountsWorkspace key={billingScope(useContext(AccessContext))} />;
}
function AccountsWorkspace() {
  const { services } = useRouteContext({ from: "__root__" }),
    access = useContext(AccessContext),
    scope = billingScope(access),
    search = accountSearch(route.useSearch()),
    navigate = route.useNavigate(),
    api = useMemo(() => createAccountsApi(services), [services]),
    plansApi = useMemo(() => createPlansApi(services), [services]);
  const filters = accountFilters(search),
    rangeInvalid =
      !!search.occurredFrom && !!search.occurredTo && search.occurredFrom > search.occurredTo;
  const list = useQuery({
      queryKey: ["billing", scope, "accounts", filters, search.page, search.pageSize, search.sort],
      queryFn: ({ signal }) =>
        api.list(
          { ...filters, page: search.page, pageSize: search.pageSize, sort: search.sort },
          signal,
        ),
      ...LIST_QUERY,
    }),
    summary = useQuery({
      queryKey: ["billing", scope, "account-summary", filters],
      queryFn: ({ signal }) => api.summary(filters, signal),
      ...DETAIL_QUERY,
    }),
    detail = useQuery({
      queryKey: ["billing", scope, "account", search.accountId],
      queryFn: ({ signal }) => api.detail(search.accountId!, signal),
      enabled: !!search.accountId,
      ...DETAIL_QUERY,
    }),
    ledger = useQuery({
      queryKey: ["billing", scope, "ledger", search.accountId, ledgerQuery(search)],
      queryFn: ({ signal }) => api.ledger(search.accountId!, ledgerQuery(search), signal),
      enabled: !!search.accountId && !rangeInvalid,
      ...DETAIL_QUERY,
    }),
    plans = useQuery({
      queryKey: ["billing", scope, "account-plan-options"],
      queryFn: ({ signal }) => plansApi.list(true, signal),
      ...DETAIL_QUERY,
    });
  const [adjustment, setAdjustment] = useState<AccountDetail>();
  const change = (patch: Record<string, unknown>) =>
    void navigate({ search: accountSearch({ ...search, ...patch }) });
  const refresh = () => {
    void list.refetch();
    void summary.refetch();
    if (search.accountId) {
      void detail.refetch();
      void ledger.refetch();
    }
  };
  const columns: NonNullable<TableProps<AccountRow>["columns"]> = [
    {
      key: "entity",
      title: "主体",
      render: (_, r) => (
        <div className="lyx-cell-2">
          <strong>{r.entity.name}</strong>
          <span className="lyx-cell-2__sub">
            {r.entity.primaryStoreName ?? "无主门店"} · {r.entity.storeCount}家门店
          </span>
        </div>
      ),
    },
    {
      key: "subscription",
      title: "套餐",
      render: (_, r) => (
        <span>
          {r.subscription.plan?.name ?? "未开通"}
          <br />
          {subStatus[r.subscription.status]} · {r.subscription.endDate ?? "—"}
        </span>
      ),
    },
    {
      key: "spendable",
      title: "可用积分",
      align: "right",
      render: (_, r) => <strong>{pointsText(r.spendablePoints)}</strong>,
    },
    {
      key: "plan",
      title: "套餐 / 加购",
      align: "right",
      render: (_, r) => (
        <span>
          {r.planAvailablePoints} / {r.addonAvailablePoints}
          {r.isAddonSuspended ? "（加购暂停）" : ""}
          <br />
          {r.planPointsExpireAt
            ? appDateTimeFormat.dateTimeFull(r.planPointsExpireAt)
            : "无套餐清零时间"}
        </span>
      ),
    },
    {
      key: "held",
      title: "冻结 / 在办",
      render: (_, r) => (
        <span>
          {r.heldPoints} 积分{r.isRefundPending ? " · 退款待处理" : ""}
          {r.hasPendingAdjustment ? " · 调整待审" : ""}
        </span>
      ),
    },
    {
      key: "open",
      title: "操作",
      render: (_, r) => (
        <Button
          size="small"
          onClick={() => change({ accountId: r.pointAccountId, cursor: undefined })}
        >
          详情与流水
        </Button>
      ),
    },
  ];
  type LedgerRow = NonNullable<typeof ledger.data>["items"][number];
  const ledgerColumns: NonNullable<TableProps<LedgerRow>["columns"]> = [
    {
      key: "time",
      title: "时间 / 业务日",
      render: (_, r) => (
        <span>
          {appDateTimeFormat.dateTimeFull(r.occurredAt)}
          <br />
          {r.bizDate}
        </span>
      ),
    },
    {
      key: "title",
      title: "事项",
      render: (_, r) => (
        <span>
          {r.title}
          <br />
          {r.formula ?? ""}
          <br />
          {r.refNo ?? ""}
        </span>
      ),
    },
    {
      key: "delta",
      title: "变动",
      align: "right",
      render: (_, r) => (
        <span>
          {r.deltaPoints > 0 ? "+" : ""}
          {r.deltaPoints} 积分
          <br />
          {r.lotKind === "plan" ? "套餐" : r.lotKind === "addon" ? "加购" : "账户门控"} ·{" "}
          {r.category}
        </span>
      ),
    },
    {
      key: "balance",
      title: "变动后余额",
      align: "right",
      render: (_, r) => (
        <span>
          可用 {r.spendableAfterPoints}
          <br />
          冻结 {r.heldAfterPoints}
        </span>
      ),
    },
    {
      key: "actor",
      title: "门店 / 操作人",
      render: (_, r) => (
        <span>
          {r.store?.name ?? "主体"}
          <br />
          {r.actor.name}
        </span>
      ),
    },
  ];
  const account = detail.data;
  return (
    <div className="billing-stack">
      <PageHeader
        title="积分账户"
        subtitle="余额、冻结与本期权益以服务端事实为准；调整申请不直接入账。"
      />
      {summary.isError ? (
        <ErrorState onRetry={() => void summary.refetch()} />
      ) : (
        <section className="lyx-card billing-panel billing-kpis" aria-label="账户统计">
          <span>账户 {summary.data?.accountCount ?? "—"}</span>
          <span>生效中 {summary.data?.activeAccountCount ?? "—"}</span>
          <span>
            积分余额（含冻结） <strong>{pointsText(summary.data?.balancePoints)}</strong>
          </span>
          <span>冻结 {pointsText(summary.data?.heldPoints)}</span>
          <span>本月发放 {pointsText(summary.data?.grantedThisMonthPoints)}</span>
          <span>本月消耗 {pointsText(summary.data?.consumedThisMonthPoints)}</span>
        </section>
      )}
      <MasterDetailPage
        label="主体账户"
        selectedKey={search.accountId}
        onSelect={(key) => change({ accountId: key, cursor: undefined })}
        onRetry={() => void detail.refetch()}
        list={() => (
          <section className="lyx-card billing-panel billing-stack">
            <div className="billing-actions">
              <Input.Search
                aria-label="搜索主体账户"
                placeholder="主体或门店"
                defaultValue={search.q}
                allowClear
                onSearch={(q) => change({ q, page: 1 })}
              />
              <Select
                aria-label="套餐筛选"
                value={search.planId}
                placeholder="全部套餐"
                allowClear
                options={plans.data?.items.map((p) => ({ value: p.planId, label: p.name }))}
                onChange={(planId) => change({ planId, page: 1 })}
              />
              <Select
                aria-label="账户状态"
                value={search.subStatus}
                placeholder="全部状态"
                allowClear
                options={Object.entries(subStatus).map(([value, label]) => ({ value, label }))}
                onChange={(value) => change({ subStatus: value, page: 1 })}
              />
              <Select
                aria-label="账户标记"
                value={search.flag}
                placeholder="全部标记"
                allowClear
                options={[
                  { value: "has_held", label: "有冻结" },
                  { value: "expiring_7d", label: "7天内清零" },
                  { value: "refund_pending", label: "退款在办" },
                ]}
                onChange={(flag) => change({ flag, page: 1 })}
              />
              <Select
                aria-label="账户排序"
                value={search.sort}
                options={[
                  { value: "-updatedAt", label: "最近更新" },
                  { value: "-spendablePoints", label: "可用积分倒序" },
                  { value: "planPointsExpireAt", label: "套餐清零时间" },
                ]}
                onChange={(sort) => change({ sort, page: 1 })}
              />
            </div>
            {list.isPending ? (
              <Skeleton active />
            ) : list.isError ? (
              <ErrorState onRetry={refresh} />
            ) : (
              <div className="billing-table">
                <Table<AccountRow>
                  rowKey="pointAccountId"
                  dataSource={list.data.items}
                  columns={columns}
                  pagination={{
                    current: search.page,
                    pageSize: search.pageSize,
                    total: list.data.total,
                    showSizeChanger: true,
                    pageSizeOptions: [10, 20, 50],
                    onChange: (page, size) => change({ page, pageSize: size }),
                  }}
                  locale={{ emptyText: "暂无符合条件的账户" }}
                />
              </div>
            )}
          </section>
        )}
        detail={
          search.accountId
            ? detail.isPending
              ? { key: search.accountId, status: "loading" }
              : detail.isError
                ? { key: search.accountId, status: "error", message: detail.error.message }
                : account
                  ? {
                      key: account.pointAccountId,
                      status: "ready",
                      content: (
                        <div className="billing-stack">
                          <h3>{account.entity.name}</h3>
                          <InfoList
                            items={[
                              { label: "可用", value: pointsText(account.spendablePoints) },
                              {
                                label: "套餐 / 加购 / 冻结",
                                value: `${account.planAvailablePoints} / ${account.addonAvailablePoints} / ${account.heldPoints}`,
                              },
                              {
                                label: "本期",
                                value: account.currentTerm
                                  ? `${account.currentTerm.planName} · ${account.currentTerm.startDate} 至 ${account.currentTerm.endDate}`
                                  : "无",
                              },
                              { label: "本期已发", value: pointsText(account.planGrantedThisTerm) },
                              {
                                label: "最后清零",
                                value: account.lastExpired
                                  ? `${account.lastExpired.points}积分 · ${appDateTimeFormat.dateTimeFull(account.lastExpired.at)}`
                                  : "无",
                              },
                              {
                                label: "预约周期",
                                value:
                                  account.scheduledTerms
                                    .map((t) => `${t.planName} ${t.startDate} 至 ${t.endDate}`)
                                    .join("；") || "无",
                              },
                            ]}
                          />
                          {account.notices.pendingRefund ? (
                            <Alert
                              type="warning"
                              title={`退款在办：${account.notices.pendingRefund.requestNo ?? account.notices.pendingRefund.refundRequestId}`}
                            />
                          ) : null}
                          {account.notices.pendingAdjustment ? (
                            <Alert
                              type="info"
                              title={`调整待审：${account.notices.pendingAdjustment.requestNo ?? "未编号"} · ${account.notices.pendingAdjustment.adjustPoints}积分`}
                            />
                          ) : null}
                          {account.notices.pendingExtension ? (
                            <Alert
                              type="info"
                              title={`延长待审：${account.notices.pendingExtension.requestNo ?? "未编号"} · ${account.notices.pendingExtension.days}天`}
                            />
                          ) : null}
                          {account.notices.pendingCancels.map((c) => (
                            <p key={c.cancelRequestId}>
                              取消在办 {c.requestNo ?? c.cancelRequestId} · {c.targetNo ?? c.kind} ·
                              待退 {c.refundPoints}积分 · {c.status}
                            </p>
                          ))}
                          {account.notices.heldAwaitingQualification.map((h) => (
                            <p key={h.pointHoldId}>
                              {h.store.name} · 资质待审冻结 {h.qty}积分 ·{" "}
                              {h.groupRef ?? h.pointHoldId}
                            </p>
                          ))}
                          {canAction(access, "billing.adjust.request") &&
                          account.actions.includes("create-point-adjustment-request") ? (
                            <Button onClick={() => setAdjustment(structuredClone(account))}>
                              发起积分调整
                            </Button>
                          ) : null}
                        </div>
                      ),
                    }
                  : undefined
            : undefined
        }
      />
      {search.accountId ? (
        <section className="lyx-card billing-panel billing-stack" aria-label="账户流水">
          <h2>账户流水</h2>
          <Tabs
            label="流水分组"
            activeKey={search.ledgerTab}
            items={[
              { key: "all", label: "全部" },
              { key: "gain", label: "获得" },
              { key: "use", label: "使用" },
              { key: "expire", label: "清零" },
            ]}
            onChange={(ledgerTab) => change({ ledgerTab, cursor: undefined })}
          />
          <div className="billing-actions">
            <Select
              aria-label="流水积分类型"
              value={search.lotKind}
              allowClear
              placeholder="全部类型"
              options={[
                { value: "plan", label: "套餐" },
                { value: "addon", label: "加购" },
              ]}
              onChange={(lotKind) => change({ lotKind, cursor: undefined })}
            />
            <Input.Search
              aria-label="流水门店ID"
              placeholder="门店ID（选填）"
              defaultValue={search.storeId}
              onSearch={(storeId) => change({ storeId, cursor: undefined })}
            />
            <DateRangeField
              key={`${search.accountId}:${search.occurredFrom}:${search.occurredTo}`}
              aria-label="流水日期范围"
              onChange={(r) =>
                change({
                  occurredFrom: r?.[0]?.format("YYYY-MM-DD"),
                  occurredTo: r?.[1]?.format("YYYY-MM-DD"),
                  cursor: undefined,
                })
              }
            />
            {search.occurredFrom || search.occurredTo ? (
              <span>
                {search.occurredFrom ?? "不限"} 至 {search.occurredTo ?? "不限"}
              </span>
            ) : null}
            <Select
              aria-label="流水每屏条数"
              value={search.ledgerLimit}
              options={[10, 20, 50].map((value) => ({ value, label: `${value}条` }))}
              onChange={(ledgerLimit) => change({ ledgerLimit, cursor: undefined })}
            />
          </div>
          {rangeInvalid ? (
            <Alert role="alert" type="error" title="开始日期不能晚于结束日期" />
          ) : ledger.isPending ? (
            <Skeleton active />
          ) : ledger.isError ? (
            <ErrorState onRetry={() => void ledger.refetch()} />
          ) : ledger.data?.items.length ? (
            <div className="billing-table">
              <Table<LedgerRow>
                rowKey="rowKey"
                columns={ledgerColumns}
                dataSource={ledger.data.items}
                pagination={false}
              />
            </div>
          ) : (
            <EmptyState title="暂无账户流水" />
          )}
          <div className="billing-actions">
            <Button disabled={!search.cursor} onClick={() => change({ cursor: undefined })}>
              返回首屏
            </Button>
            <Button
              disabled={
                !ledger.data?.hasMore ||
                !ledger.data.nextCursor ||
                ledger.isFetching ||
                rangeInvalid
              }
              onClick={() => change({ cursor: ledger.data?.nextCursor ?? undefined })}
            >
              下一屏
            </Button>
            <span>按服务端游标继续，不用近似总数计算页码。</span>
          </div>
        </section>
      ) : null}
      {adjustment ? (
        <AdjustmentDialog
          key={adjustment.pointAccountId}
          row={adjustment}
          api={api}
          onClose={() => setAdjustment(undefined)}
          onSaved={(no) => {
            showSuccessNotice(`调整申请已提交${no ? `：${no}` : ""}，审批后入账`);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}
