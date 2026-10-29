import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Card, Input, Space, Spin } from "antd";
import { useContext, useEffect, useMemo, useState } from "react";
import { InfoList } from "../../../components/InfoList";
import { PageHeader } from "../../../components/PageHeader";
import { QueryTablePage, type QueryColumn } from "../../../components/QueryTablePage";
import { canRequestRefund, paymentRefundTarget, type RefundTarget } from "../refunds/request-model";
import { RefundRequestDialog } from "../refunds/request";
import { AccessContext } from "../../../lib/permissions";
import { DETAIL_QUERY, LIST_QUERY } from "../../../lib/query";
import { writeTableSearch, type TableSearch } from "../../../lib/table-search";
import { createPaymentsApi, financeReadError, type PaymentRow } from "./api";
import {
  channelLabel,
  financeScope,
  moneyText,
  orderTypeLabel,
  paymentFilters,
  paymentSearch,
  paymentTableSearch,
  reconLabel,
} from "./model";

const route = getRouteApi("/finance/payments");
export function PaymentsPage() {
  return <PaymentsWorkspace key={financeScope(useContext(AccessContext))} />;
}
function PaymentsWorkspace() {
  const { services } = useRouteContext({ from: "__root__" }),
    access = useContext(AccessContext),
    scope = financeScope(access),
    search = paymentSearch(route.useSearch()),
    navigate = route.useNavigate(),
    api = useMemo(() => createPaymentsApi(services), [services]),
    filters = paymentFilters(search),
    invalidRange =
      !!search.successFrom && !!search.successTo && search.successFrom > search.successTo;
  const [refundTarget, setRefundTarget] = useState<RefundTarget & { selectionScope: string }>();
  const selectionScope = JSON.stringify(search);
  const activeRefund = refundTarget?.selectionScope === selectionScope ? refundTarget : undefined;
  const list = useQuery({
      queryKey: ["finance", scope, "payments", search],
      queryFn: ({ signal }) => api.list(search, signal),
      enabled: !invalidRange,
      ...LIST_QUERY,
      placeholderData: undefined,
    }),
    summary = useQuery({
      queryKey: ["finance", scope, "payment-summary", filters],
      queryFn: ({ signal }) => api.summary(filters, signal),
      enabled: !invalidRange,
      ...DETAIL_QUERY,
    });
  const change = (next: TableSearch) =>
    void navigate({ search: paymentSearch(writeTableSearch(next)) });
  const dateChange = (key: "successFrom" | "successTo", value: string) =>
    void navigate({ search: paymentSearch({ ...search, [key]: value, page: 1 }) });
  useEffect(() => {
    if (!list.data || list.isFetching || list.isError) return;
    const last = Math.max(1, Math.ceil(list.data.total / list.data.pageSize));
    if (search.page > last) void navigate({ search: { ...search, page: last }, replace: true });
  }, [list.data, list.isFetching, list.isError, search, navigate]);
  const columns: QueryColumn<PaymentRow>[] = [
    {
      key: "transaction",
      title: "交易单号 / 付款单",
      render: (r) => (
        <div className="lyx-cell-2">
          <strong>{r.channelTxnNo}</strong>
          <span className="lyx-cell-2__sub">{r.paymentOrder?.orderNo ?? "未关联付款单"}</span>
        </div>
      ),
    },
    {
      key: "entity",
      title: "商家 / 付款人",
      render: (r) => (
        <div className="lyx-cell-2">
          <span>{r.entity?.name ?? "未关联主体"}</span>
          <span className="lyx-cell-2__sub">{r.payerName ?? "—"}</span>
        </div>
      ),
    },
    {
      key: "success",
      title: "收款时间 / 方式",
      render: (r) => (
        <div className="lyx-cell-2">
          <span>{appDateTimeFormat.dateTimeFull(r.channelSuccessAt)}</span>
          <span className="lyx-cell-2__sub">
            {channelLabel(r.channel)} · {r.paymentOrder ? orderTypeLabel(r.paymentOrder.type) : "—"}
          </span>
        </div>
      ),
    },
    {
      key: "amount",
      title: "收款 / 手续费",
      align: "right",
      render: (r) => (
        <div className="lyx-cell-2">
          <strong>{moneyText(r.channelAmountFen)}</strong>
          <span className="lyx-cell-2__sub">手续费 {moneyText(r.feeFen)}</span>
        </div>
      ),
    },
    { key: "refund", title: "累计已退款", align: "right", render: (r) => moneyText(r.refundedFen) },
    {
      key: "state",
      title: "入账 / 对账",
      render: (r) => (
        <div className="lyx-cell-2">
          <span>{r.isApplied ? "已入账" : "未入账"}</span>
          <span className="lyx-cell-2__sub">{reconLabel(r.reconState)}</span>
        </div>
      ),
    },
    {
      key: "actions",
      title: "差异 / 退款",
      render: (row) => {
        const target = paymentRefundTarget(row);
        return (
          <Space orientation="vertical">
            <a
              className="lyx-link"
              href={`/finance/reconcile?tab=all&q=${encodeURIComponent(row.paymentOrder?.orderNo ?? row.channelTxnNo)}`}
            >
              查看关联差异
            </a>
            {canRequestRefund(access) && target ? (
              <Button size="small" onClick={() => setRefundTarget({ ...target, selectionScope })}>
                申请现金退款
              </Button>
            ) : null}
            {row.paymentOrder ? (
              <a
                className="lyx-link"
                href={`/finance/refunds?tab=all&q=${encodeURIComponent(row.paymentOrder.orderNo)}`}
              >
                查看退款记录
              </a>
            ) : (
              <span>未关联付款单</span>
            )}
          </Space>
        );
      },
    },
  ];
  return (
    <>
      {activeRefund ? (
        <RefundRequestDialog
          key={`${scope}:${activeRefund.paymentOrderId}:${activeRefund.paymentTransactionId}`}
          target={activeRefund}
          services={services}
          scope={scope}
          onClose={() => setRefundTarget(undefined)}
          onCreated={() => {
            void list.refetch();
            void summary.refetch();
          }}
        />
      ) : null}
      <PageHeader
        title="收款流水"
        subtitle="按渠道成功时间查看真实收款、入账与对账结果"
        extra={
          <Button
            onClick={() =>
              void navigate({
                to: "/finance/settings",
                search: {
                  tab: "current",
                  page: 1,
                  pageSize: 20,
                  configKey: undefined,
                  id: undefined,
                },
              })
            }
          >
            受控财务配置
          </Button>
        }
      />
      {invalidRange ? <Alert type="warning" title="收款开始日期不能晚于结束日期" /> : null}
      {summary.isError ? (
        <Alert
          type="warning"
          title="收款统计读取失败"
          action={<Button onClick={() => void summary.refetch()}>重试统计</Button>}
        />
      ) : null}
      {summary.isPending && !invalidRange ? <Spin aria-label="收款统计加载中" /> : null}
      {summary.data && !summary.isError && !invalidRange ? (
        <Card title="收款概况">
          <InfoList
            labelWidth={110}
            items={[
              {
                label: "筛选结果",
                value: `${summary.data.filtered.count} 笔 · ${moneyText(summary.data.filtered.channelAmountFen)}`,
              },
              {
                label: "今日收款",
                value: `${moneyText(summary.data.today.amountFen)} · ${summary.data.today.count} 笔`,
              },
              {
                label: "本月收款",
                value: `${moneyText(summary.data.month.amountFen)} · ${summary.data.month.count} 笔`,
              },
              {
                label: "本月退款",
                value: `${moneyText(summary.data.monthRefund.amountFen)} · ${summary.data.monthRefund.count} 笔`,
              },
              {
                label: "未结对账差异",
                value: `${moneyText(summary.data.openDiff.amountFen)} · ${summary.data.openDiff.count} 笔`,
              },
              { label: "最早差异日", value: summary.data.openDiff.earliestBillDate ?? "—" },
            ]}
          />
        </Card>
      ) : null}
      <QueryTablePage
        label="收款流水"
        search={paymentTableSearch(search)}
        onSearchChange={change}
        keywordPlaceholder="搜索付款单号、交易单号、商家"
        columns={columns}
        rowKey={(r) => r.paymentTransactionId}
        filters={[
          {
            key: "orderType",
            placeholder: "全部付款类型",
            options: ["plan_new", "plan_renew", "plan_upgrade", "topup"].map((value) => ({
              value,
              label: orderTypeLabel(value),
            })),
          },
          {
            key: "channel",
            placeholder: "全部收款方式",
            options: ["wechat_jsapi", "bank_transfer"].map((value) => ({
              value,
              label: channelLabel(value),
            })),
          },
          {
            key: "reconState",
            placeholder: "全部对账状态",
            options: ["pending", "matched", "diff", "resolved"].map((value) => ({
              value,
              label: reconLabel(value),
            })),
          },
          {
            key: "isApplied",
            placeholder: "全部入账状态",
            options: [
              { value: "true", label: "已入账" },
              { value: "false", label: "未入账" },
            ],
          },
        ]}
        toolbar={
          <Space wrap>
            <Input
              type="date"
              aria-label="收款开始日期"
              value={search.successFrom ?? ""}
              onChange={(e) => dateChange("successFrom", e.target.value)}
            />
            <span>至</span>
            <Input
              type="date"
              aria-label="收款结束日期"
              value={search.successTo ?? ""}
              onChange={(e) => dateChange("successTo", e.target.value)}
            />
          </Space>
        }
        query={
          invalidRange
            ? { status: "error", message: "请调整收款日期区间" }
            : list.isPending
              ? { status: "loading" }
              : list.isError
                ? { status: "error", message: financeReadError }
                : { status: "success", items: list.data.items, total: list.data.total }
        }
        refreshing={list.isFetching}
        onRetry={() => {
          if (!invalidRange) void list.refetch();
        }}
        empty={{ title: "暂无收款流水", filteredTitle: "没有符合条件的收款流水" }}
      />
    </>
  );
}
