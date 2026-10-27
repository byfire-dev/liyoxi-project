import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Button, Checkbox, Skeleton, Table, type TableProps } from "antd";
import { useContext, useMemo, useState } from "react";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { PageHeader } from "../../../components/PageHeader";
import { EmptyState, ErrorState } from "../../../components/StateBlock";
import { InfoList } from "../../../components/InfoList";
import { AccessContext, canAction } from "../../../lib/permissions";
import { DETAIL_QUERY, LIST_QUERY } from "../../../lib/query";
import { showSuccessNotice } from "../../../app/feedback";
import { createBillingParamsApi } from "../params/api";
import { billingScope, moneyText, pointsText, plansSearch } from "./model";
import { createPlansApi, type PlanColumn, type PlanRevision } from "./api";
import { PlanNameDialog, PlanRevisionDialog } from "./forms";
import { PlanQuotePanel } from "./quote";
import { BillingConfirm } from "./confirm";
import "./billing.css";
const route = getRouteApi("/billing/plans");
const statusText: Record<string, string> = {
  pending_change: "待生效调整",
  listed: "已上架",
  delisted: "已下架",
  draft: "草稿",
  pending: "待生效",
  effective: "生效中",
  superseded: "历史",
  cancelled: "已撤回",
};
export function PlansPage() {
  return <PlansWorkspace key={billingScope(useContext(AccessContext))} />;
}
function PlansWorkspace() {
  const { services } = useRouteContext({ from: "__root__" }),
    access = useContext(AccessContext),
    scope = billingScope(access),
    search = plansSearch(route.useSearch()),
    navigate = route.useNavigate(),
    api = useMemo(() => createPlansApi(services), [services]),
    paramsApi = useMemo(() => createBillingParamsApi(services), [services]);
  const list = useQuery({
      queryKey: ["billing", scope, "plans", search.includeDelisted],
      queryFn: ({ signal }) => api.list(search.includeDelisted, signal),
      ...LIST_QUERY,
    }),
    summary = useQuery({
      queryKey: ["billing", scope, "plan-summary"],
      queryFn: ({ signal }) => api.summary(signal),
      ...DETAIL_QUERY,
    }),
    revisions = useQuery({
      queryKey: [
        "billing",
        scope,
        "plan-revisions",
        search.planId,
        search.revisionPage,
        search.revisionSize,
      ],
      queryFn: ({ signal }) =>
        api.revisions(search.planId!, search.revisionPage, search.revisionSize, signal),
      enabled: !!search.planId,
      ...LIST_QUERY,
    });
  const [editing, setEditing] = useState<{ row?: PlanColumn }>(),
    [revision, setRevision] = useState<{ row: PlanColumn; cycles: number[] }>(),
    [listing, setListing] = useState<{ row: PlanColumn; action: "shelve" | "delist" }>(),
    [withdraw, setWithdraw] = useState<PlanRevision>();
  const params = useQuery({
    queryKey: ["billing", scope, "param-metadata"],
    queryFn: ({ signal }) => paramsApi.list(signal),
    enabled: !!revision,
    ...DETAIL_QUERY,
  });
  const canEdit = canAction(access, "billing.plan.edit"),
    refresh = () => {
      void list.refetch();
      void summary.refetch();
      if (search.planId) void revisions.refetch();
    },
    saved = () => {
      showSuccessNotice("套餐配置已保存");
      refresh();
    },
    choose = (planId: string) => void navigate({ search: { ...search, planId, revisionPage: 1 } });
  const columns: NonNullable<TableProps<PlanColumn>["columns"]> = [
    {
      key: "name",
      title: "套餐 / 状态",
      render: (_, row) => (
        <div className="lyx-cell-2">
          <strong>{row.name}</strong>
          <span className="lyx-cell-2__sub">
            {row.code} · {statusText[row.columnStatus] ?? row.columnStatus}
          </span>
        </div>
      ),
    },
    {
      key: "price",
      title: "当前价目",
      render: (_, row) =>
        row.current ? (
          <div className="lyx-cell-2">
            <strong>{moneyText(row.current.monthlyFeeFen)} / 月</strong>
            <span className="lyx-cell-2__sub">
              第{row.current.revisionNo}版 · {pointsText(row.current.monthlyPoints)}
            </span>
          </div>
        ) : (
          "暂无生效价目"
        ),
    },
    {
      key: "benefits",
      title: "权益",
      render: (_, row) =>
        row.current ? (
          <span>
            {row.current.maxStores}家门店 / {row.current.maxMembers ?? "不限"}位成员
            <br />
            {row.current.productionModel} · {row.current.schedulePriority}
          </span>
        ) : (
          "—"
        ),
    },
    { key: "count", title: "生效主体", align: "right", render: (_, row) => row.activeEntityCount },
    {
      key: "pending",
      title: "待生效",
      render: (_, row) =>
        row.pending ? (
          <span>
            第{row.pending.revisionNo}版<br />
            {appDateTimeFormat.dateTimeFull(row.pending.effectiveAt)}
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "actions",
      title: "操作",
      render: (_, row) => (
        <div className="billing-actions">
          <Button size="small" onClick={() => choose(row.planId)}>
            修订记录
          </Button>
          {canEdit && row.actions.includes("update") ? (
            <Button size="small" onClick={() => setEditing({ row: structuredClone(row) })}>
              改名
            </Button>
          ) : null}
          {canEdit && row.actions.includes("create-plan-revision") ? (
            <Button
              size="small"
              onClick={() => {
                if (list.data)
                  setRevision({
                    row: structuredClone(row),
                    cycles: [
                      ...new Set([
                        ...list.data.enabledCycles.current,
                        ...(list.data.enabledCycles.pending?.value ?? []),
                      ]),
                    ],
                  });
              }}
            >
              发布修订
            </Button>
          ) : null}
          {canEdit
            ? row.actions
                .filter((a): a is "shelve" | "delist" => a === "shelve" || a === "delist")
                .map((action) => (
                  <Button
                    key={action}
                    size="small"
                    danger={action === "delist"}
                    onClick={() => setListing({ row: structuredClone(row), action })}
                  >
                    {action === "shelve" ? "上架" : "下架"}
                  </Button>
                ))
            : null}
        </div>
      ),
    },
  ];
  const historyColumns: NonNullable<TableProps<PlanRevision>["columns"]> = [
    {
      key: "version",
      title: "修订",
      render: (_, row) => `第${row.revisionNo}版 · ${statusText[row.status] ?? row.status}`,
    },
    {
      key: "price",
      title: "月费 / 积分",
      render: (_, row) => `${moneyText(row.monthlyFeeFen)} / ${pointsText(row.monthlyPoints)}`,
    },
    {
      key: "at",
      title: "生效时间",
      render: (_, row) => appDateTimeFormat.dateTimeFull(row.effectiveAt),
    },
    {
      key: "notice",
      title: "公告",
      render: (_, row) =>
        row.notice ? (
          <span>
            {row.notice.title}
            <br />
            {row.notice.summary}
          </span>
        ) : (
          "首次价目或无公告"
        ),
    },
    {
      key: "actions",
      title: "操作",
      render: (_, row) =>
        canEdit && row.actions.includes("withdraw") ? (
          <Button size="small" danger onClick={() => setWithdraw(structuredClone(row))}>
            撤回
          </Button>
        ) : (
          "只读"
        ),
    },
  ];
  const selected = list.data?.items.find((r) => r.planId === search.planId);
  return (
    <div className="billing-stack">
      <PageHeader
        title="套餐管理"
        subtitle="价目与公告按服务端生效时间展示，历史权益与付款快照保持。"
        extra={
          canEdit ? (
            <Button type="primary" onClick={() => setEditing({})}>
              新建套餐
            </Button>
          ) : undefined
        }
      />
      {summary.isError ? (
        <ErrorState onRetry={() => void summary.refetch()} />
      ) : (
        <section className="lyx-card billing-panel billing-kpis" aria-label="套餐统计">
          <span>
            生效主体 <strong>{summary.data?.activeEntityCount ?? "—"}</strong>
          </span>
          <span>
            月度经常性收入 <strong>{moneyText(summary.data?.mrrFen)}</strong>
          </span>
          <span>本月新开通 {summary.data?.newThisMonthCount ?? "—"}</span>
          <span>本月续费 {summary.data?.renewedThisMonthCount ?? "—"}</span>
        </section>
      )}
      <section className="lyx-card billing-panel">
        <Checkbox
          checked={search.includeDelisted}
          onChange={(e) =>
            void navigate({ search: { ...search, includeDelisted: e.target.checked } })
          }
        >
          含未上架版本
        </Checkbox>
        {list.isPending ? (
          <Skeleton active />
        ) : list.isError ? (
          <ErrorState onRetry={refresh} />
        ) : !list.data.items.length ? (
          <EmptyState title="暂无套餐" />
        ) : (
          <div className="billing-table">
            <Table<PlanColumn>
              rowKey="planId"
              columns={columns}
              dataSource={list.data.items}
              pagination={false}
            />
          </div>
        )}
        {list.data ? (
          <p>
            可购买周期：{list.data.enabledCycles.current.map((m) => `${m}个月`).join("、")}
            {list.data.enabledCycles.pending
              ? `；待生效周期 ${list.data.enabledCycles.pending.value.join("、")}个月 · ${appDateTimeFormat.dateTimeFull(list.data.enabledCycles.pending.effectiveAt)}`
              : ""}
          </p>
        ) : null}
      </section>
      {list.data ? (
        <div className="billing-grid">
          <section className="lyx-card billing-panel">
            <h2>{selected ? `${selected.name} · 当前权益` : "套餐权益"}</h2>
            {selected?.current ? (
              <InfoList
                items={[
                  { label: "每月积分", value: pointsText(selected.current.monthlyPoints) },
                  { label: "订购折扣", value: `${selected.current.discountBp} / 10000` },
                  { label: "门店上限", value: selected.current.maxStores },
                  { label: "成员上限", value: selected.current.maxMembers ?? "不限" },
                  {
                    label: "月度报告",
                    value: selected.current.hasMonthlyReport ? "包含" : "不包含",
                  },
                  {
                    label: "首期优惠",
                    value: selected.current.hasFirstCyclePromo ? "沿用上一价目" : "无",
                  },
                  ...selected.current.cyclePrices.map((p) => ({
                    label: `${p.months}个月`,
                    value: moneyText(p.priceFen),
                  })),
                ]}
              />
            ) : (
              <EmptyState title="请选择有当前价目的套餐" />
            )}
          </section>
          <PlanQuotePanel
            key={JSON.stringify([
              list.data.items.map((p) => [p.planId, p.current?.planRevisionId, p.isListed]),
              list.data.enabledCycles,
            ])}
            api={api}
            plans={list.data.items}
            cycles={list.data.enabledCycles.current}
          />
        </div>
      ) : null}
      {search.planId ? (
        <section className="lyx-card billing-panel">
          <h2>价目修订与公告记录</h2>
          {revisions.isPending ? (
            <Skeleton active />
          ) : revisions.isError ? (
            <ErrorState onRetry={() => void revisions.refetch()} />
          ) : revisions.data ? (
            <div className="billing-table">
              <Table<PlanRevision>
                rowKey="planRevisionId"
                columns={historyColumns}
                dataSource={revisions.data.items}
                pagination={{
                  current: search.revisionPage,
                  pageSize: search.revisionSize,
                  total: revisions.data.total,
                  showSizeChanger: true,
                  pageSizeOptions: [10, 20, 50],
                  onChange: (page, size) =>
                    void navigate({
                      search: { ...search, revisionPage: page, revisionSize: size },
                    }),
                }}
              />
            </div>
          ) : null}
        </section>
      ) : null}
      {editing ? (
        <PlanNameDialog
          key={editing.row?.planId ?? "new"}
          api={api}
          row={editing.row}
          onClose={() => setEditing(undefined)}
          onSaved={saved}
        />
      ) : null}
      {revision ? (
        <PlanRevisionDialog
          key={revision.row.planId}
          api={api}
          row={revision.row}
          cycles={revision.cycles}
          earliestDate={params.data?.earliestNoticedEffectiveDate}
          onClose={() => setRevision(undefined)}
          onSaved={saved}
        />
      ) : null}
      {listing ? (
        <BillingConfirm
          key={`${listing.row.planId}:${listing.action}`}
          action={`plan-${listing.action}`}
          spec={{
            title: `${listing.action === "shelve" ? "上架" : "下架"}套餐`,
            echo: [
              { label: "套餐", value: listing.row.name },
              { label: "版本码", value: listing.row.code },
            ],
            checkLabel: "已核对套餐及当前价目",
            danger: listing.action === "delist",
          }}
          submit={(key, signal) => api[listing.action](listing.row.planId, key, signal)}
          onClose={() => setListing(undefined)}
          onSaved={() => {
            setListing(undefined);
            saved();
          }}
          onConflict={refresh}
        />
      ) : null}
      {withdraw ? (
        <BillingConfirm
          key={withdraw.planRevisionId}
          action="plan-revision-withdraw"
          spec={{
            title: "撤回待生效价目",
            echo: [
              { label: "修订", value: `第${withdraw.revisionNo}版` },
              { label: "生效时间", value: appDateTimeFormat.dateTimeFull(withdraw.effectiveAt) },
            ],
            checkLabel: "已核对，确认撤回价目及关联公告",
            danger: true,
          }}
          submit={(key, signal) =>
            api.withdraw(
              withdraw.planRevisionId,
              {
                confirm: {
                  planRevisionId: withdraw.planRevisionId,
                  effectiveAt: withdraw.effectiveAt,
                },
              },
              key,
              signal,
            )
          }
          onClose={() => setWithdraw(undefined)}
          onSaved={() => {
            setWithdraw(undefined);
            saved();
          }}
          onConflict={refresh}
        />
      ) : null}
    </div>
  );
}
