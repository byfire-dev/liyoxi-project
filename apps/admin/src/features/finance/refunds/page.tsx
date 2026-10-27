import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Card, Spin } from "antd";
import { useContext, useEffect, useMemo } from "react";
import { InfoList } from "../../../components/InfoList";
import { MasterDetailPage } from "../../../components/MasterDetailPage";
import { PageHeader } from "../../../components/PageHeader";
import { QueryTablePage, type QueryColumn } from "../../../components/QueryTablePage";
import { AccessContext } from "../../../lib/permissions";
import { DETAIL_QUERY, LIST_QUERY } from "../../../lib/query";
import { writeTableSearch, type TableSearch } from "../../../lib/table-search";
import { financeReadError } from "../payments/api";
import { financeScope, moneyText } from "../payments/model";
import { createRefundsApi, type RefundRow } from "./api";
import { refreshAdjustmentDetail } from "../credit-adjust/model";
import { createRefundDecisionsApi } from "./decision-api";
import { RefundDecisionPanel } from "./decision";
import { createRefundExecutionApi } from "./execution-api";
import { RefundExecutionPanel } from "./execution";
import { OfflineRefundReceipt } from "./offline-upload";
import { RefundReadDetail } from "./detail";
import {
  refundFilters,
  refundLabel,
  refundSearch,
  refundTableSearch,
  ruleLabels,
  sourceLabels,
  tabLabels,
} from "./model";

const route = getRouteApi("/finance/refunds");
export function RefundsPage() {
  return <RefundsWorkspace key={financeScope(useContext(AccessContext))} />;
}
function RefundsWorkspace() {
  const { services } = useRouteContext({ from: "__root__" }),
    scope = financeScope(useContext(AccessContext)),
    search = refundSearch(route.useSearch()),
    navigate = route.useNavigate(),
    api = useMemo(() => createRefundsApi(services), [services]),
    decisions = createRefundDecisionsApi(services),
    execution = createRefundExecutionApi(services),
    cache = useQueryClient(),
    filters = refundFilters(search);
  const list = useQuery({
      queryKey: ["finance", scope, "refunds", filters, search.tab, search.page, search.pageSize],
      queryFn: ({ signal }) =>
        api.list(
          { ...filters, tab: search.tab, page: search.page, pageSize: search.pageSize },
          signal,
        ),
      ...LIST_QUERY,
      placeholderData: undefined,
    }),
    summary = useQuery({
      queryKey: ["finance", scope, "refund-summary", filters],
      queryFn: ({ signal }) => api.summary(filters, signal),
      ...DETAIL_QUERY,
    }),
    detail = useQuery({
      queryKey: ["finance", scope, "refund", search.refundRequestId],
      queryFn: ({ signal }) => api.detail(search.refundRequestId!, signal),
      enabled: !!search.refundRequestId,
      ...DETAIL_QUERY,
    });
  const select = (refundRequestId: string | undefined) =>
    void navigate({ search: { ...search, refundRequestId } });
  const change = (next: TableSearch) =>
    void navigate({ search: refundSearch(writeTableSearch(next)) });
  useEffect(() => {
    if (!list.data || list.isFetching || list.isError) return;
    const last = Math.max(1, Math.ceil(list.data.total / list.data.pageSize));
    if (search.page > last)
      void navigate({
        search: { ...search, page: last, refundRequestId: undefined },
        replace: true,
      });
  }, [list.data, list.isFetching, list.isError, search, navigate]);
  const columns: QueryColumn<RefundRow>[] = [
    {
      key: "request",
      title: "申请单 / 来源",
      render: (r) => (
        <div className="lyx-cell-2">
          <strong>{r.requestNo}</strong>
          <span className="lyx-cell-2__sub">{sourceLabels[r.source]}</span>
        </div>
      ),
    },
    {
      key: "entity",
      title: "商家 / 付款单",
      render: (r) => (
        <div className="lyx-cell-2">
          <span>{r.entity?.name ?? "未关联主体"}</span>
          <span className="lyx-cell-2__sub">{r.paymentOrder?.orderNo ?? "未关联付款单"}</span>
        </div>
      ),
    },
    {
      key: "amount",
      title: "申请金额 / 规则",
      align: "right",
      render: (r) => (
        <div className="lyx-cell-2">
          <strong>{moneyText(r.amountFen)}</strong>
          <span className="lyx-cell-2__sub">{r.ruleText}</span>
        </div>
      ),
    },
    {
      key: "state",
      title: "状态 / 执行时限",
      render: (r) => (
        <div className="lyx-cell-2">
          <span>
            {refundLabel(r)}
            {r.hasExecError ? " · 需处理" : ""}
          </span>
          <span className="lyx-cell-2__sub">
            {r.execDueAt ? appDateTimeFormat.dateTimeFull(r.execDueAt) : "—"}
            {r.isExecOverdue ? " · 已超时" : ""}
          </span>
        </div>
      ),
    },
    {
      key: "created",
      title: "申请时间",
      render: (r) => appDateTimeFormat.dateTimeFull(r.createdAt),
    },
    {
      key: "detail",
      title: "详情",
      render: (r) => (
        <Button type="link" onClick={() => select(r.refundRequestId)}>
          查看
        </Button>
      ),
    },
  ];
  return (
    <>
      <PageHeader title="退款管理" subtitle="现金退款申请、渠道结果与权益回收记录" />
      {summary.isError ? (
        <Alert
          type="warning"
          title="退款统计读取失败"
          action={<Button onClick={() => void summary.refetch()}>重试统计</Button>}
        />
      ) : null}
      {summary.isPending ? <Spin aria-label="退款统计加载中" /> : null}
      {summary.data && !summary.isError ? (
        <Card title="现金退款概况">
          <InfoList
            labelWidth={110}
            items={[
              {
                label: "本月已退款",
                value: `${moneyText(summary.data.monthRefunded.amountFen)} · ${summary.data.monthRefunded.count} 笔`,
              },
              { label: "审批与执行中", value: `${summary.data.inProgressCount} 笔` },
              { label: "其中渠道执行中", value: `${summary.data.executingCount} 笔` },
              { label: "本月驳回", value: `${summary.data.monthRejectedCount} 笔` },
              { label: "已超时", value: `${summary.data.overdueCount} 笔` },
            ]}
          />
        </Card>
      ) : null}
      {search.entityId || search.storeId ? (
        <Alert type="info" title="当前按链接指定的主体或门店筛选，可通过重置筛选查看全部授权记录" />
      ) : null}
      <MasterDetailPage
        label="现金退款主从详情"
        selectedKey={search.refundRequestId}
        onSelect={select}
        detailTitle="退款详情"
        onRetry={() => void detail.refetch()}
        detail={
          search.refundRequestId
            ? detail.isPending
              ? { key: search.refundRequestId, status: "loading" }
              : detail.isError
                ? { key: search.refundRequestId, status: "error", message: financeReadError }
                : {
                    key: search.refundRequestId,
                    status: "ready",
                    content: (
                      <div key={search.refundRequestId}>
                        <RefundReadDetail
                          detail={detail.data!}
                          receipt={(fileId) => (
                            <OfflineRefundReceipt
                              key={fileId}
                              services={services}
                              fileId={fileId}
                            />
                          )}
                        />
                        <RefundDecisionPanel
                          key={search.refundRequestId}
                          detail={detail.data!}
                          api={decisions}
                          refresh={(signal) =>
                            refreshAdjustmentDetail(
                              cache,
                              ["finance", scope, "refund", search.refundRequestId],
                              signal,
                              (own) => api.detail(search.refundRequestId!, own),
                            )
                          }
                          changed={() => {
                            void cache.invalidateQueries({
                              queryKey: ["finance", scope, "refunds"],
                            });
                            void cache.invalidateQueries({
                              queryKey: ["finance", scope, "refund-summary"],
                            });
                          }}
                        />
                        <RefundExecutionPanel
                          key={`${search.refundRequestId}:execution`}
                          detail={detail.data!}
                          api={execution}
                          services={services}
                          read={(signal) => api.detail(search.refundRequestId!, signal)}
                          refresh={(signal) =>
                            refreshAdjustmentDetail(
                              cache,
                              ["finance", scope, "refund", search.refundRequestId],
                              signal,
                              (own) => api.detail(search.refundRequestId!, own),
                            )
                          }
                          changed={() => {
                            void cache.invalidateQueries({
                              queryKey: ["finance", scope, "refunds"],
                            });
                            void cache.invalidateQueries({
                              queryKey: ["finance", scope, "refund-summary"],
                            });
                          }}
                        />
                      </div>
                    ),
                  }
            : undefined
        }
        list={({ selectedKey, onSelect }) => (
          <QueryTablePage
            label="现金退款申请"
            search={refundTableSearch(search)}
            onSearchChange={change}
            defaultTab="pending_approval"
            tabs={[
              {
                key: "pending_approval",
                label: tabLabels.pending_approval,
                count: summary.isError ? undefined : summary.data?.tabs.pending_approval,
              },
              {
                key: "pending_execution",
                label: tabLabels.pending_execution,
                count: summary.isError ? undefined : summary.data?.tabs.pending_execution,
              },
              {
                key: "processed",
                label: tabLabels.processed,
                count: summary.isError ? undefined : summary.data?.tabs.processed,
              },
              { key: "all", label: tabLabels.all },
            ]}
            keywordPlaceholder="搜索退款单号、付款单号、商家"
            filters={[
              {
                key: "source",
                placeholder: "全部申请来源",
                options: Object.entries(sourceLabels).map(([value, label]) => ({ value, label })),
              },
              {
                key: "ruleCode",
                placeholder: "全部退款规则",
                options: Object.entries(ruleLabels).map(([value, label]) => ({ value, label })),
              },
              {
                key: "overdueOnly",
                placeholder: "全部时限",
                options: [
                  { value: "true", label: "仅超时申请" },
                  { value: "false", label: "不限是否超时" },
                ],
              },
            ]}
            columns={columns}
            rowKey={(r) => r.refundRequestId}
            selectedRowKey={selectedKey}
            onRowClick={(r) => onSelect(r.refundRequestId)}
            rowTone={(r) => (r.isExecOverdue || r.hasExecError ? "danger" : undefined)}
            query={
              list.isPending
                ? { status: "loading" }
                : list.isError
                  ? { status: "error", message: financeReadError }
                  : { status: "success", items: list.data.items, total: list.data.total }
            }
            refreshing={list.isFetching}
            onRetry={() => void list.refetch()}
            empty={{ title: "暂无现金退款申请", filteredTitle: "没有符合条件的现金退款申请" }}
          />
        )}
      />
    </>
  );
}
