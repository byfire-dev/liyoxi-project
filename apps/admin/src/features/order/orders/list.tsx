import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Checkbox, Input, Select } from "antd";
import { useState } from "react";
import { PageHeader } from "../../../components/PageHeader";
import { QueryTablePage, type QueryColumn } from "../../../components/QueryTablePage";
import { StatusTag } from "../../../components/StatusTag";
import { LIST_QUERY, DICT_QUERY } from "../../../lib/query";
import { writeTableSearch, withFilter } from "../../../lib/table-search";
import { createOrdersApi, type OrderCard } from "./api";
import {
  orderSearch,
  orderQuery,
  orderFilters,
  orderTabs,
  ORDERS_KEY,
  models,
  platforms,
  subStatuses,
} from "./model";
import "./orders.css";
const route = getRouteApi("/orders");
export function OrderStatus({ row }: { row: Pick<OrderCard, "status" | "subStatus"> }) {
  const tone = statusToneByEnum("drama_order.status", String(row.status))?.admin;
  return (
    <span className="lyx-cell-2">
      {tone ? <StatusTag tone={tone.tone}>{tone.label}</StatusTag> : String(row.status)}
      <span className="lyx-cell-2__sub">
        {row.subStatus ? (subStatuses[String(row.subStatus)] ?? String(row.subStatus)) : null}
      </span>
    </span>
  );
}
export function OrdersPage() {
  const { services } = useRouteContext({ from: "__root__" }),
    navigate = route.useNavigate();
  const search = orderSearch(route.useSearch()),
    api = createOrdersApi(services),
    query = orderQuery(search),
    filters = orderFilters(search);
  const list = useQuery({
    queryKey: [...ORDERS_KEY, "list", query],
    queryFn: () => api.list(query),
    ...LIST_QUERY,
  });
  const summary = useQuery({
    queryKey: [...ORDERS_KEY, "summary", filters],
    queryFn: () => api.summary(filters),
    ...LIST_QUERY,
  });
  const managers = useQuery({
    queryKey: [...ORDERS_KEY, "managers"],
    queryFn: api.managers,
    ...DICT_QUERY,
  });
  const [filterError, setFilterError] = useState<string>();
  const change = (next: typeof search) => {
    if (
      next.filters.submittedFrom &&
      next.filters.submittedTo &&
      next.filters.submittedFrom > next.filters.submittedTo
    ) {
      setFilterError("开始日期不能晚于结束日期");
      return;
    }
    setFilterError(undefined);
    void navigate({ search: writeTableSearch(orderSearch(writeTableSearch(next))) });
  };
  const open = (row: OrderCard) =>
    void navigate({
      to: "/orders/$orderNo",
      params: { orderNo: row.orderNo },
      state: (previous) => ({
        ...previous,
        lyxOrder: { orderNo: row.orderNo, orderId: row.orderId },
      }),
    });
  const columns: QueryColumn<OrderCard>[] = [
    {
      key: "orderNo",
      title: "订单号",
      width: 160,
      render: (row) => (
        <button className="lyx-order-link lyx-link" onClick={() => open(row)}>
          {row.orderNo}
        </button>
      ),
    },
    {
      key: "submittedAt",
      title: "下单时间",
      width: 105,
      sortField: "submittedAt",
      render: (row) => appDateTimeFormat.dateTime(row.submittedAt),
    },
    {
      key: "store",
      title: "商家",
      render: (row) => (
        <span className="lyx-cell-2">
          <strong>{row.store.storeName ?? "未命名门店"}</strong>
          <span className="lyx-cell-2__sub">{row.planName ?? "—"}</span>
        </span>
      ),
    },
    {
      key: "drama",
      title: "剧目",
      render: (row) => (
        <span className="lyx-cell-2">
          <strong>
            {row.firstDramaTitle}
            {row.itemCount > 1 ? ` 等 ${row.itemCount} 部` : ""}
          </strong>
          <span className="lyx-cell-2__sub">整部 {row.firstEpisodeCount} 集 · 门店定制</span>
        </span>
      ),
    },
    {
      key: "platform",
      title: "发布账号",
      width: 65,
      render: (row) => row.platforms.map((p) => platforms[p] ?? p).join("、") || "—",
    },
    {
      key: "model",
      title: "制作模型",
      width: 78,
      render: (row) => row.productionModels.map((m) => models[m] ?? m).join("、"),
    },
    {
      key: "points",
      title: "应扣积分",
      width: 82,
      align: "right",
      render: (row) => <strong>{row.totalChargePoints.toLocaleString("zh-CN")}</strong>,
    },
    { key: "status", title: "订单状态", width: 105, render: (row) => <OrderStatus row={row} /> },
    {
      key: "manager",
      title: "交付经理",
      width: 78,
      render: (row) => row.deliveryManager?.name ?? "未分配",
    },
    {
      key: "detail",
      title: "操作",
      width: 54,
      align: "right",
      render: (row) => (
        <button className="lyx-order-link lyx-link" onClick={() => open(row)}>
          详情
        </button>
      ),
    },
  ];
  return (
    <>
      <PageHeader title="订购单" subtitle="提交时冻结积分，开始制作时扣减；每部剧为门店独立定制" />
      {filterError ? <Alert type="warning" title={filterError} /> : null}
      <QueryTablePage
        label="订购单"
        search={search}
        onSearchChange={change}
        keywordPlaceholder="订单号、商家或剧名"
        tabs={orderTabs.map((tab) => ({
          key: tab,
          label:
            tab === "all"
              ? "全部"
              : (statusToneByEnum("drama_order.status", tab)?.admin?.label ?? tab),
          count: summary.data?.tabs[tab],
        }))}
        filters={[
          {
            key: "deliveryManagerId",
            placeholder: "全部交付经理",
            options: [
              { value: "none", label: "未分配" },
              ...(managers.data?.items.map((m) => ({ value: m.staffId, label: m.name })) ?? []),
            ],
          },
        ]}
        toolbar={
          <div className="lyx-order-filters">
            <Input
              type="date"
              aria-label="下单开始日期"
              value={search.filters.submittedFrom ?? ""}
              onChange={(e) => change(withFilter(search, "submittedFrom", e.target.value))}
            />
            <span>至</span>
            <Input
              type="date"
              aria-label="下单结束日期"
              value={search.filters.submittedTo ?? ""}
              min={search.filters.submittedFrom}
              onChange={(e) => change(withFilter(search, "submittedTo", e.target.value))}
            />
            <Checkbox
              checked={search.filters.isRejectedStale === "true"}
              onChange={(e) =>
                change(withFilter(search, "isRejectedStale", e.target.checked ? "true" : undefined))
              }
            >
              仅看资质驳回超期
            </Checkbox>
            <Select
              aria-label="订单排序"
              value={search.sort}
              onChange={(value) => change({ ...search, sort: value, page: 1 })}
              options={[
                { value: "-submittedAt", label: "下单时间倒序" },
                { value: "submittedAt", label: "下单时间正序" },
                { value: "-statusChangedAt", label: "状态更新时间" },
              ]}
            />
          </div>
        }
        columns={columns}
        rowKey={(row) => row.orderId}
        onRowClick={open}
        query={
          list.isPending
            ? { status: "loading" }
            : list.isError
              ? { status: "error", message: list.error.message }
              : { status: "success", items: list.data.items, total: list.data.total }
        }
        refreshing={list.isFetching}
        onRetry={() => void list.refetch()}
        empty={{ title: "暂无订购单" }}
      />
    </>
  );
}
