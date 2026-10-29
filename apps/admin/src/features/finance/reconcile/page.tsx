import { calendarDate } from "@liyoxi/shared/time";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Input, Space, Spin } from "antd";
import { useContext, useEffect, useState } from "react";
import { MasterDetailPage } from "../../../components/MasterDetailPage";
import { PageHeader } from "../../../components/PageHeader";
import { QueryTablePage, type QueryColumn } from "../../../components/QueryTablePage";
import { AccessContext } from "../../../lib/permissions";
import { DETAIL_QUERY, LIST_QUERY } from "../../../lib/query";
import { readTableSearch, writeTableSearch, type TableSearch } from "../../../lib/table-search";
import { financeScope, moneyText } from "../payments/model";
import { createReconcileApi, reconError } from "./api";
import { CreateException } from "./create";
import { ExceptionFacts } from "./detail";
import { dayStatus, exceptionStatus, kindLabels } from "./labels";
import {
  canReconcile,
  canCreateException,
  exceptionQuery,
  reconcileSearch,
  refreshReconcile,
  resolutions,
} from "./model";
import { MonthFacts } from "./month";
import { RerunDay } from "./rerun";
import { ResolveException } from "./resolve";
import type { ExceptionDetail, ExceptionRow, RerunTarget } from "./types";

const route = getRouteApi("/finance/reconcile"),
  tabLabels = { open: "待处理", resolving: "审批处理中", resolved: "已处理", all: "全部" } as const;
export function ReconcilePage() {
  return (
    <ReconcileWorkspace
      key={`${financeScope(useContext(AccessContext))}:${reconcileSearch(route.useSearch()).month ?? "current"}`}
    />
  );
}
function ReconcileWorkspace() {
  const access = useContext(AccessContext),
    scope = financeScope(access),
    { services } = useRouteContext({ from: "__root__" }),
    api = createReconcileApi(services),
    search = reconcileSearch(route.useSearch()),
    navigate = route.useNavigate(),
    cache = useQueryClient(),
    month = search.month ?? calendarDate(new Date()).slice(0, 7),
    invalidRange =
      !!search.billDateFrom && !!search.billDateTo && search.billDateFrom > search.billDateTo,
    selectedId = invalidRange ? undefined : search.paymentExceptionId,
    prefix = ["finance", scope, "reconcile"] as const,
    monthKey = [...prefix, "month", month],
    filters = exceptionQuery(search),
    listKey = [...prefix, "list", filters],
    detailKey = [...prefix, "detail", selectedId],
    [create, setCreate] = useState(false),
    [resolve, setResolve] = useState(false),
    [rerun, setRerun] = useState<RerunTarget>(),
    [notice, setNotice] = useState<string>();
  const monthly = useQuery({
      queryKey: monthKey,
      queryFn: ({ signal }) => api.month(month, signal),
      ...DETAIL_QUERY,
      placeholderData: undefined,
    }),
    list = useQuery({
      queryKey: listKey,
      queryFn: ({ signal }) => api.list(filters, signal),
      enabled: !invalidRange,
      ...LIST_QUERY,
      placeholderData: undefined,
    }),
    detail = useQuery({
      queryKey: detailKey,
      queryFn: ({ signal }) => api.detail(selectedId!, signal),
      enabled: !!selectedId,
      ...DETAIL_QUERY,
      placeholderData: undefined,
    });
  const select = (id: string | undefined) => {
      setResolve(false);
      void navigate({ search: { ...search, paymentExceptionId: id } });
    },
    change = (next: TableSearch) => {
      setResolve(false);
      void navigate({
        search: reconcileSearch({
          ...writeTableSearch(next),
          month: search.month,
          paymentExceptionId: undefined,
        }),
      });
    },
    dateChange = (key: "billDateFrom" | "billDateTo", value: string) => {
      setResolve(false);
      void navigate({
        search: reconcileSearch({
          ...search,
          [key]: value,
          page: 1,
          paymentExceptionId: undefined,
        }),
      });
    };
  useEffect(() => {
    if (!list.data || list.isFetching || list.isError || invalidRange) return;
    const last = Math.max(1, Math.ceil(list.data.total / list.data.pageSize));
    if (search.page > last)
      void navigate({
        search: { ...search, page: last, paymentExceptionId: undefined },
        replace: true,
      });
  }, [list.data, list.isFetching, list.isError, invalidRange, search, navigate]);
  async function refresh(signal: AbortSignal, value?: ExceptionDetail) {
    const id = value?.paymentExceptionId ?? selectedId;
    await Promise.all([
      refreshReconcile(cache, monthKey, signal, (own) => api.month(month, own)),
      ...(!invalidRange
        ? [refreshReconcile(cache, listKey, signal, (own) => api.list(filters, own))]
        : []),
      ...(id
        ? [refreshReconcile(cache, [...prefix, "detail", id], signal, (own) => api.detail(id, own))]
        : []),
    ]);
    signal.throwIfAborted();
  }
  const columns: QueryColumn<ExceptionRow>[] = [
    {
      key: "no",
      title: "差异单 / 类型",
      render: (row) => (
        <div>
          <strong>{row.exceptionNo}</strong>
          <div>{kindLabels[row.kind]}</div>
        </div>
      ),
    },
    {
      key: "subject",
      title: "商家 / 付款单",
      render: (row) => (
        <div>
          {row.entity?.name ?? "未关联主体"}
          <div>{row.paymentOrder?.orderNo ?? "未关联付款单"}</div>
        </div>
      ),
    },
    { key: "date", title: "账单日", render: (row) => row.billDate },
    { key: "amount", title: "差异金额", align: "right", render: (row) => moneyText(row.amountFen) },
    { key: "cause", title: "差异原因", render: (row) => row.causeText ?? "—" },
    {
      key: "status",
      title: "状态",
      render: (row) => `${exceptionStatus[row.status]}${row.isOverdue ? " · 已超时" : ""}`,
    },
    {
      key: "detail",
      title: "详情",
      render: (row) => (
        <Button type="link" onClick={() => select(row.paymentExceptionId)}>
          查看差异
        </Button>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title="对账与差异"
        subtitle="按实际账单与平台事实核对，处理结果以服务端重读为准"
        extra={
          canCreateException(access) ? (
            <Button onClick={() => setCreate(true)}>登记未关联收款</Button>
          ) : null
        }
      />
      <Space wrap>
        <label>
          对账月份
          <Input
            type="month"
            value={month}
            onChange={(e) => {
              setResolve(false);
              void navigate({
                search: reconcileSearch({
                  ...search,
                  month: e.target.value,
                  paymentExceptionId: undefined,
                }),
              });
            }}
          />
        </label>
        <Button onClick={() => void monthly.refetch()}>刷新月度对账</Button>
      </Space>
      {notice ? (
        <Alert type="info" title={notice} closable onClose={() => setNotice(undefined)} />
      ) : null}
      {monthly.isPending ? (
        <Spin aria-label="月度对账加载中" />
      ) : monthly.isError ? (
        <Alert
          type="warning"
          title={reconError(monthly.error)}
          action={<Button onClick={() => void monthly.refetch()}>重读月度对账</Button>}
        />
      ) : (
        <MonthFacts
          value={monthly.data}
          mayRerun={canReconcile(access) && !monthly.isFetching}
          rerun={setRerun}
          select={select}
        />
      )}
      {invalidRange ? <Alert type="warning" title="账单开始日期不能晚于结束日期" /> : null}
      <MasterDetailPage
        label="对账差异主从详情"
        selectedKey={selectedId}
        onSelect={select}
        detailTitle="差异详情与处理"
        onRetry={() => void detail.refetch()}
        detail={
          selectedId
            ? detail.isPending
              ? { key: selectedId, status: "loading" }
              : detail.isError
                ? { key: selectedId, status: "error", message: reconError(detail.error) }
                : {
                    key: selectedId,
                    status: "ready",
                    content: (
                      <div key={selectedId}>
                        <ExceptionFacts value={detail.data!} />
                        {resolutions(detail.data!, access).length ? (
                          <Button
                            type="primary"
                            disabled={detail.isFetching}
                            onClick={() => setResolve(true)}
                          >
                            处理差异
                          </Button>
                        ) : null}
                        {resolve ? (
                          <ResolveException
                            key={selectedId}
                            value={detail.data!}
                            api={api}
                            services={services}
                            refresh={(signal) => refresh(signal)}
                            onClose={() => setResolve(false)}
                            onDone={(value) => {
                              setResolve(false);
                              setNotice(
                                value.outcome === "refund_requested"
                                  ? "退款申请已生成，等待审批与执行；尚未退款"
                                  : value.outcome === "still_blocked"
                                    ? "已尝试履约，差异仍受阻，请查看最新详情"
                                    : "处理已提交，已读取最新差异与对账结果",
                              );
                            }}
                          />
                        ) : null}
                      </div>
                    ),
                  }
            : undefined
        }
        list={({ selectedKey, onSelect }) => (
          <QueryTablePage
            label="资金对账差异"
            search={readTableSearch(search, ["kind", "billDateFrom", "billDateTo"])}
            onSearchChange={change}
            defaultTab="open"
            tabs={Object.entries(tabLabels).map(([key, label]) => ({ key, label }))}
            keywordPlaceholder="搜索差异单号、付款单号或商家"
            filters={[
              {
                key: "kind",
                placeholder: "全部差异类型",
                options: Object.entries(kindLabels).map(([value, label]) => ({ value, label })),
              },
            ]}
            toolbar={
              <Space wrap>
                <Input
                  type="date"
                  aria-label="账单开始日期"
                  value={search.billDateFrom ?? ""}
                  onChange={(e) => dateChange("billDateFrom", e.target.value)}
                />
                <span>至</span>
                <Input
                  type="date"
                  aria-label="账单结束日期"
                  value={search.billDateTo ?? ""}
                  onChange={(e) => dateChange("billDateTo", e.target.value)}
                />
              </Space>
            }
            columns={columns}
            rowKey={(row) => row.paymentExceptionId}
            selectedRowKey={selectedKey}
            onRowClick={(row) => onSelect(row.paymentExceptionId)}
            rowTone={(row) => (row.isOverdue ? "danger" : undefined)}
            query={
              invalidRange
                ? { status: "error", message: "请调整账单日期区间" }
                : list.isPending
                  ? { status: "loading" }
                  : list.isError
                    ? { status: "error", message: reconError(list.error) }
                    : { status: "success", items: list.data.items, total: list.data.total }
            }
            refreshing={list.isFetching}
            onRetry={() => {
              if (!invalidRange) void list.refetch();
            }}
            empty={{ title: "暂无资金差异", filteredTitle: "没有符合条件的资金差异" }}
          />
        )}
      />
      {create && canCreateException(access) ? (
        <CreateException
          api={api}
          refresh={refresh}
          onCreated={(id) => {
            setCreate(false);
            select(id);
            setNotice("未关联收款已登记为待处理差异，尚未入账");
          }}
          onClose={() => setCreate(false)}
        />
      ) : null}
      {rerun && canReconcile(access) ? (
        <RerunDay
          key={rerun.reconciliationId}
          value={rerun}
          api={api}
          refresh={(signal) => refresh(signal)}
          onDone={(row) => {
            setRerun(undefined);
            setNotice(`${row.billDate} 重跑已返回：${dayStatus[row.status]}，已读取最新月度结果`);
          }}
          onClose={() => setRerun(undefined)}
        />
      ) : null}
    </>
  );
}
