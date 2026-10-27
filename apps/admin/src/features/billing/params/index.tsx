import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Select, Skeleton, Table, type TableProps } from "antd";
import { useContext, useMemo, useState } from "react";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { PageHeader } from "../../../components/PageHeader";
import { Tabs } from "../../../components/Tabs";
import { DiffBlock } from "../../../components/DiffBlock";
import { DateRangeField } from "../../../components/DateRangeField";
import { EmptyState, ErrorState } from "../../../components/StateBlock";
import { ReadOnlyValue } from "../../../components/ReadOnlyValue";
import { AccessContext, canAction } from "../../../lib/permissions";
import { LIST_QUERY, DETAIL_QUERY } from "../../../lib/query";
import { showSuccessNotice } from "../../../app/feedback";
import { billingScope } from "../plans/model";
import { BillingConfirm } from "../plans/confirm";
import { createBillingParamsApi, type BillingParam, type BillingParamsApi } from "./api";
import { PricingChangeDialog } from "./forms";
import { PARAM_LABELS, paramText, paramsSearch } from "./model";
const route = getRouteApi("/billing/params");
type RecordRow = Awaited<ReturnType<BillingParamsApi["history"]>>["items"][number];
export function BillingParamsPage() {
  return <ParamsWorkspace key={billingScope(useContext(AccessContext))} />;
}
function ParamsWorkspace() {
  const { services } = useRouteContext({ from: "__root__" }),
    access = useContext(AccessContext),
    scope = billingScope(access),
    search = paramsSearch(route.useSearch()),
    navigate = route.useNavigate(),
    api = useMemo(() => createBillingParamsApi(services), [services]),
    badRange = !!search.createdFrom && !!search.createdTo && search.createdFrom > search.createdTo;
  const list = useQuery({
      queryKey: ["billing", scope, "params"],
      queryFn: ({ signal }) => api.list(signal),
      ...DETAIL_QUERY,
    }),
    tiers = useQuery({
      queryKey: ["billing", scope, "tiers"],
      queryFn: ({ signal }) => api.tiers(signal),
      ...DETAIL_QUERY,
    }),
    history = useQuery({
      queryKey: ["billing", scope, "pricing-changes", search],
      queryFn: ({ signal }) =>
        api.history(
          {
            page: search.page,
            pageSize: search.pageSize,
            kind: search.kind,
            key: search.key,
            createdFrom: search.createdFrom,
            createdTo: search.createdTo,
          },
          signal,
        ),
      enabled: search.tab === "history" && !badRange,
      ...LIST_QUERY,
    });
  const [editing, setEditing] = useState<{
      params: BillingParam[];
      tiers: NonNullable<typeof tiers.data>;
      earliest: string;
    }>(),
    [withdraw, setWithdraw] = useState<BillingParam>();
  const canParams = canAction(access, "billing.param.edit"),
    canTiers = canAction(access, "billing.price.edit"),
    refresh = () => {
      void list.refetch();
      void tiers.refetch();
      if (search.tab === "history") void history.refetch();
    },
    saved = () => {
      showSuccessNotice("计费变更已保存");
      refresh();
    };
  const columns: NonNullable<TableProps<BillingParam>["columns"]> = [
    { key: "key", title: "参数", render: (_, row) => <strong>{PARAM_LABELS[row.key]}</strong> },
    {
      key: "value",
      title: "当前值",
      render: (_, row) => <span className="billing-value">{paramText(row.current.value)}</span>,
    },
    {
      key: "at",
      title: "生效版本",
      render: (_, row) => (
        <span>
          {appDateTimeFormat.dateTimeFull(row.current.effectiveAt)}
          <br />
          {row.current.createdBy?.name ?? "种子"}
        </span>
      ),
    },
    {
      key: "pending",
      title: "待生效",
      render: (_, row) =>
        row.pending ? (
          <span>
            {paramText(row.pending.value)}
            <br />
            {appDateTimeFormat.dateTimeFull(row.pending.effectiveAt)}
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "action",
      title: "操作",
      render: (_, row) =>
        canParams && row.pending && row.actions.includes("withdraw") ? (
          <Button size="small" danger onClick={() => setWithdraw(structuredClone(row))}>
            撤回
          </Button>
        ) : (
          "只读"
        ),
    },
  ];
  const historyColumns: NonNullable<TableProps<RecordRow>["columns"]> = [
    {
      key: "time",
      title: "提交时间 / 操作人",
      render: (_, row) => (
        <span>
          {appDateTimeFormat.dateTimeFull(row.createdAt)}
          <br />
          {row.createdBy?.name ?? "种子"}
        </span>
      ),
    },
    {
      key: "summary",
      title: "变更摘要",
      render: (_, row) => (
        <span>
          {row.summaryText}
          <br />
          {row.note ?? ""}
        </span>
      ),
    },
    {
      key: "compare",
      title: "前后对照",
      render: (_, row) => (
        <div className="billing-stack">
          {row.tierItems.map((t) => (
            <DiffBlock
              key={t.priceTierRevisionId}
              ariaLabel={`${t.tier}档变更`}
              before={paramText(t.previousPoints)}
              after={paramText(t.points)}
            />
          ))}
          {row.paramItems.map((p) => (
            <DiffBlock
              key={p.billingParamId}
              ariaLabel={`${PARAM_LABELS[p.key]}变更`}
              before={paramText(p.previousValue)}
              after={
                <span>
                  {paramText(p.value)} · {p.status}
                  <br />
                  {appDateTimeFormat.dateTimeFull(p.effectiveAt)}
                </span>
              }
            />
          ))}
        </div>
      ),
    },
    {
      key: "notice",
      title: "公告",
      render: (_, row) => (row.notice ? `${row.notice.title} · ${row.notice.status}` : "无"),
    },
  ];
  return (
    <div className="billing-stack">
      <PageHeader
        title="积分价模板与参数"
        subtitle="当前值、待生效值和历史独立展示；只保存本次选中的改动。"
        extra={
          canParams || canTiers ? (
            <Button
              type="primary"
              disabled={!list.data || !tiers.data}
              onClick={() => {
                if (list.data && tiers.data)
                  setEditing({
                    params: structuredClone(list.data.items),
                    tiers: structuredClone(tiers.data),
                    earliest: list.data.earliestNoticedEffectiveDate,
                  });
              }}
            >
              新建变更集
            </Button>
          ) : undefined
        }
      />
      <section className="lyx-card">
        <Tabs
          label="参数视图"
          activeKey={search.tab}
          items={[
            { key: "current", label: "当前与待生效" },
            { key: "history", label: "变更记录" },
          ]}
          onChange={(tab) => void navigate({ search: paramsSearch({ ...search, tab, page: 1 }) })}
        />
        {search.tab === "current" ? (
          <div className="billing-panel billing-stack">
            {tiers.isPending ? (
              <Skeleton active />
            ) : tiers.isError ? (
              <ErrorState onRetry={() => void tiers.refetch()} />
            ) : (
              <section aria-label="当前等级模板">
                <h2>当前等级模板</h2>
                <div className="billing-kpis">
                  {tiers.data.items.map((t) => (
                    <ReadOnlyValue
                      key={t.tier}
                      label={`${t.tier}档`}
                      value={`${t.points.toLocaleString("zh-CN")} 积分`}
                      reason={`${appDateTimeFormat.dateTimeFull(t.effectiveAt)} · ${t.templateDramaCount}部模板价短剧`}
                    />
                  ))}
                </div>
              </section>
            )}
            {list.isPending ? (
              <Skeleton active />
            ) : list.isError ? (
              <ErrorState onRetry={() => void list.refetch()} />
            ) : (
              <>
                <p>
                  公告天数：{list.data.noticeDays}天；需公告参数最早生效日：
                  {list.data.earliestNoticedEffectiveDate}
                </p>
                <div className="billing-table">
                  <Table<BillingParam>
                    rowKey="key"
                    columns={columns}
                    dataSource={list.data.items}
                    pagination={false}
                  />
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="billing-panel billing-stack">
            <div className="billing-actions">
              <Select
                aria-label="变更类型"
                value={search.kind ?? "all"}
                options={[
                  { value: "all", label: "全部类型" },
                  { value: "price_tier", label: "模板价" },
                  { value: "billing_param", label: "计费参数" },
                ]}
                onChange={(kind) =>
                  void navigate({
                    search: paramsSearch({
                      ...search,
                      kind: kind === "all" ? undefined : kind,
                      page: 1,
                    }),
                  })
                }
              />
              <Select
                aria-label="变更参数"
                allowClear
                value={search.key}
                placeholder="全部参数"
                options={list.data?.items.map((r) => ({
                  value: r.key,
                  label: PARAM_LABELS[r.key],
                }))}
                onChange={(key) => void navigate({ search: { ...search, key, page: 1 } })}
              />
              <DateRangeField
                key={`${search.createdFrom}:${search.createdTo}`}
                aria-label="修改提交日期筛选"
                format="YYYY-MM-DD"
                onChange={(range) =>
                  void navigate({
                    search: {
                      ...search,
                      createdFrom: range?.[0]?.format("YYYY-MM-DD"),
                      createdTo: range?.[1]?.format("YYYY-MM-DD"),
                      page: 1,
                    },
                  })
                }
              />
              {search.createdFrom || search.createdTo ? (
                <span>
                  当前：{search.createdFrom ?? "不限"} 至 {search.createdTo ?? "不限"}
                </span>
              ) : null}
              <Button
                type="link"
                onClick={() =>
                  void navigate({
                    search: paramsSearch({ tab: "history", page: 1, pageSize: search.pageSize }),
                  })
                }
              >
                重置筛选
              </Button>
            </div>
            {badRange ? (
              <Alert role="alert" type="error" title="开始日期不能晚于结束日期" />
            ) : history.isPending ? (
              <Skeleton active />
            ) : history.isError ? (
              <ErrorState onRetry={() => void history.refetch()} />
            ) : history.data?.items.length ? (
              <div className="billing-table">
                <Table<RecordRow>
                  rowKey="changeSetId"
                  columns={historyColumns}
                  dataSource={history.data.items}
                  pagination={{
                    current: search.page,
                    pageSize: search.pageSize,
                    total: history.data.total,
                    showSizeChanger: true,
                    pageSizeOptions: [10, 20, 50],
                    onChange: (page, pageSize) =>
                      void navigate({ search: paramsSearch({ ...search, page, pageSize }) }),
                  }}
                />
              </div>
            ) : (
              <EmptyState title="暂无变更记录" />
            )}
          </div>
        )}
      </section>
      {editing ? (
        <PricingChangeDialog
          api={api}
          params={editing.params}
          tiers={editing.tiers}
          earliestDate={editing.earliest}
          canParams={canParams}
          canTiers={canTiers}
          onClose={() => setEditing(undefined)}
          onSaved={saved}
        />
      ) : null}
      {withdraw?.pending ? (
        <BillingConfirm
          key={withdraw.pending.billingParamId}
          action="billing-param-withdraw"
          spec={{
            title: "撤回待生效参数",
            echo: [
              { label: "参数", value: PARAM_LABELS[withdraw.key] },
              { label: "待生效值", value: paramText(withdraw.pending.value) },
              {
                label: "生效时间",
                value: appDateTimeFormat.dateTimeFull(withdraw.pending.effectiveAt),
              },
            ],
            checkLabel: "已核对待生效修订与公告，确认撤回",
            danger: true,
          }}
          submit={(key, signal) =>
            api.withdraw(
              withdraw.pending!.billingParamId,
              { confirm: { key: withdraw.key, effectiveAt: withdraw.pending!.effectiveAt } },
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
