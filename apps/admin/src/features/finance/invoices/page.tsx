import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Card } from "antd";
import { useContext, useEffect } from "react";
import { InfoList } from "../../../components/InfoList";
import { MasterDetailPage } from "../../../components/MasterDetailPage";
import { PageHeader } from "../../../components/PageHeader";
import { QueryTablePage, type QueryColumn } from "../../../components/QueryTablePage";
import { AccessContext, hasModuleLevel } from "../../../lib/permissions";
import { DETAIL_QUERY, QUEUE_QUERY } from "../../../lib/query";
import { writeTableSearch } from "../../../lib/table-search";
import { financeScope, moneyText } from "../payments/model";
import { createInvoiceApi, invoiceError } from "./api";
import { InvoiceActions } from "./actions";
import { InvoiceDetail } from "./detail";
import {
  invoiceFilters,
  invoiceMedia,
  invoiceSearch,
  invoiceStatuses,
  invoiceTable,
  invoiceTabs,
  invoiceTypes,
  refreshInvoiceDetail,
} from "./model";
import type { InvoiceRow } from "./types";

const route = getRouteApi("/finance/invoices");
export function InvoicesPage() {
  return <InvoiceWorkspace key={financeScope(useContext(AccessContext))} />;
}
function InvoiceWorkspace() {
  const access = useContext(AccessContext),
    scope = financeScope(access),
    enabled = hasModuleLevel(access, "finance"),
    { services } = useRouteContext({ from: "__root__" }),
    api = createInvoiceApi(services),
    search = invoiceSearch(route.useSearch()),
    navigate = route.useNavigate(),
    cache = useQueryClient(),
    filters = invoiceFilters(search),
    prefix = ["finance", scope, "invoices"],
    selectedId = enabled ? search.id : undefined,
    list = useQuery({
      queryKey: [...prefix, "list", filters, search.tab, search.page, search.pageSize],
      queryFn: ({ signal }) =>
        api.list(
          { ...filters, tab: search.tab, page: search.page, pageSize: search.pageSize },
          signal,
        ),
      enabled,
      ...QUEUE_QUERY,
      placeholderData: undefined,
    }),
    summary = useQuery({
      queryKey: [...prefix, "summary", filters],
      queryFn: ({ signal }) => api.summary(filters, signal),
      enabled,
      ...QUEUE_QUERY,
      placeholderData: undefined,
    }),
    detailKey = [...prefix, "detail", selectedId],
    detail = useQuery({
      queryKey: detailKey,
      queryFn: ({ signal }) => api.get(selectedId!, signal),
      enabled: !!selectedId,
      ...DETAIL_QUERY,
    });
  const select = (id: string | undefined) => void navigate({ search: { ...search, id } });
  useEffect(() => {
    if (!list.data || list.isFetching || list.isError || !enabled) return;
    const last = Math.max(1, Math.ceil(list.data.total / list.data.pageSize));
    if (search.page > last)
      void navigate({ search: { ...search, page: last, id: undefined }, replace: true });
  }, [list.data, list.isFetching, list.isError, enabled, search, navigate]);
  const columns: QueryColumn<InvoiceRow>[] = [
      {
        key: "request",
        title: "申请单 / 主体",
        render: (row) => (
          <div className="lyx-cell-2">
            <strong>{row.requestNo}</strong>
            <span className="lyx-cell-2__sub">{row.entity.name}</span>
          </div>
        ),
      },
      {
        key: "order",
        title: "付款单 / 项目",
        render: (row) => (
          <div className="lyx-cell-2">
            <span>{row.paymentOrder.orderNo}</span>
            <span className="lyx-cell-2__sub">{row.paymentOrder.title}</span>
          </div>
        ),
      },
      { key: "amount", title: "开票金额", render: (row) => moneyText(row.amountFen) },
      {
        key: "type",
        title: "类型 / 介质",
        render: (row) => `${invoiceTypes[row.invoiceType]} · ${invoiceMedia[row.medium]}`,
      },
      {
        key: "status",
        title: "状态",
        render: (row) => (
          <div className="lyx-cell-2">
            <span>{invoiceStatuses[row.status] ?? "未知状态"}</span>
            <span className="lyx-cell-2__sub">
              {row.isHeldByRefund ? "退款处理中，暂停开具" : (row.resultNote ?? "—")}
            </span>
          </div>
        ),
      },
      {
        key: "applied",
        title: "申请时间",
        render: (row) => appDateTimeFormat.dateTimeFull(row.appliedAt),
      },
      {
        key: "due",
        title: "处理期限",
        render: (row) => (row.dueAt ? appDateTimeFormat.dateTimeFull(row.dueAt) : "—"),
      },
      {
        key: "detail",
        title: "详情",
        render: (row) => (
          <Button type="link" onClick={() => select(row.invoiceRequestId)}>
            查看申请
          </Button>
        ),
      },
    ],
    counts = summary.isError ? undefined : summary.data;
  return (
    <>
      <PageHeader
        title="发票管理"
        subtitle="开票队列、真实发票记录与红冲回填；邮件受理以服务端结果为准"
      />
      {summary.isError ? (
        <Alert
          type="warning"
          title={invoiceError(summary.error)}
          action={<Button onClick={() => void summary.refetch()}>重试统计</Button>}
        />
      ) : null}
      {counts ? (
        <Card title="发票概况">
          <InfoList
            labelWidth={110}
            items={[
              { label: "待开票", value: counts.pending },
              { label: "待红冲", value: counts.red_pending },
              { label: "待开票金额", value: <strong>{moneyText(counts.pendingAmountFen)}</strong> },
              { label: "本月已开金额", value: moneyText(counts.issuedThisMonth.amountFen) },
              { label: "本月已开张数", value: counts.issuedThisMonth.count },
            ]}
          />
        </Card>
      ) : null}
      <MasterDetailPage
        label="发票管理主从详情"
        selectedKey={selectedId}
        onSelect={select}
        detailTitle="开票申请详情"
        onRetry={() => void detail.refetch()}
        detail={
          selectedId
            ? detail.isPending
              ? { key: selectedId, status: "loading" }
              : detail.isError
                ? { key: selectedId, status: "error", message: invoiceError(detail.error) }
                : {
                    key: selectedId,
                    status: "ready",
                    content: (
                      <div key={selectedId}>
                        <InvoiceDetail row={detail.data!} api={api} />
                        <InvoiceActions
                          key={selectedId}
                          row={detail.data!}
                          api={api}
                          services={services}
                          scope={scope}
                          refresh={(signal) =>
                            refreshInvoiceDetail(cache, detailKey, signal, (own) =>
                              api.get(selectedId, own),
                            )
                          }
                          changed={() => {
                            void cache.invalidateQueries({ queryKey: [...prefix, "list"] });
                            void cache.invalidateQueries({ queryKey: [...prefix, "summary"] });
                          }}
                        />
                      </div>
                    ),
                  }
            : undefined
        }
        list={({ selectedKey, onSelect }) => (
          <QueryTablePage
            label="发票申请队列"
            search={invoiceTable(search)}
            onSearchChange={(next) =>
              void navigate({ search: invoiceSearch(writeTableSearch(next)) })
            }
            defaultTab="pending"
            tabs={Object.entries(invoiceTabs).map(([key, label]) => ({
              key,
              label,
              count: counts?.[key as keyof typeof invoiceTabs],
            }))}
            keywordPlaceholder="搜索申请单、付款单或主体"
            filters={[
              {
                key: "invoiceType",
                placeholder: "全部发票类型",
                options: Object.entries(invoiceTypes).map(([value, label]) => ({ value, label })),
              },
              {
                key: "medium",
                placeholder: "全部介质",
                options: Object.entries(invoiceMedia).map(([value, label]) => ({ value, label })),
              },
            ]}
            columns={columns}
            rowKey={(row) => row.invoiceRequestId}
            selectedRowKey={selectedKey}
            onRowClick={(row) => onSelect(row.invoiceRequestId)}
            rowTone={(row) => (row.isHeldByRefund ? "danger" : undefined)}
            query={
              list.isPending
                ? { status: "loading" }
                : list.isError
                  ? { status: "error", message: invoiceError(list.error) }
                  : { status: "success", items: list.data!.items, total: list.data!.total }
            }
            refreshing={list.isFetching}
            onRetry={() => void list.refetch()}
            empty={{ title: "暂无发票申请", filteredTitle: "没有符合条件的发票申请" }}
          />
        )}
      />
    </>
  );
}
