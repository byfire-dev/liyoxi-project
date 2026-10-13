import { SOURCE_TYPE, QUALIFICATION_STATUS } from "@liyoxi/contract";
import "../detail/merchant.css";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Input, Modal, Select } from "antd";
import { useContext, useState } from "react";
import { FormField } from "../../../components/FormField";
import { PageHeader } from "../../../components/PageHeader";
import { QueryTablePage, type QueryColumn } from "../../../components/QueryTablePage";
import { AccessContext } from "../../../lib/permissions";
import { LIST_QUERY } from "../../../lib/query";
import { readTableSearch, writeTableSearch } from "../../../lib/table-search";
import { createMerchantApi, type StoreRow } from "../detail/api";
import { amount, MERCHANT_KEY, merchantScope, moment, status, text } from "../detail/model";
import { merchantListQuery, merchantListSearch, merchantSummaryQuery, STORE_KEYS } from "./model";
const route = getRouteApi("/merchants");
const advanced = [
  ["regionCode", "地区代码"],
  ["industryCode", "行业代码"],
  ["categoryCode", "品类代码"],
  ["planId", "套餐 ID"],
  ["deliveryManagerId", "交付经理 ID"],
  ["entityId", "主体 ID"],
] as const;
export function MerchantListPage() {
  const access = useContext(AccessContext);
  return <MerchantListContent key={merchantScope(access)} />;
}
function MerchantListContent() {
  const access = useContext(AccessContext),
    { services } = useRouteContext({ from: "__root__" });
  const navigate = route.useNavigate(),
    search = merchantListSearch(route.useSearch()),
    api = createMerchantApi(services);
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState<Record<string, string>>({});
  const identity = merchantScope(access),
    query = merchantListQuery(search);
  const rows = useQuery({
    queryKey: [...MERCHANT_KEY, identity, "list", query],
    queryFn: () => api.stores(query),
    ...LIST_QUERY,
    placeholderData: undefined,
  });
  const summary = useQuery({
    queryKey: [...MERCHANT_KEY, identity, "summary", merchantSummaryQuery(search)],
    queryFn: () => api.summary(merchantSummaryQuery(search)),
    ...LIST_QUERY,
    placeholderData: undefined,
  });
  const change = (next: Record<string, unknown>) =>
    void navigate({ search: merchantListSearch(next) });
  const columns: QueryColumn<StoreRow>[] = [
    {
      key: "store",
      title: "门店 / 主体",
      render: (r) => (
        <span className="lyx-cell-2">
          <a className="lyx-link" href={`/merchants/${r.storeId}`}>
            {text(r.name)}
          </a>
          <span className="lyx-cell-2__sub">
            {text(r.entity.name)} · {r.isPrimary ? "主店" : "分店"} · {r.entity.activeStoreCount}{" "}
            家在用店
          </span>
        </span>
      ),
    },
    {
      key: "region",
      title: "地区 / 行业",
      render: (r) => (
        <span className="lyx-cell-2">
          {[r.region.city?.name, r.region.district?.name].filter(Boolean).join(" · ") || "—"}
          <span className="lyx-cell-2__sub">
            {text(r.industry?.name)} / {text(r.category?.name)}
          </span>
        </span>
      ),
    },
    {
      key: "qualification",
      title: "资质 / 来源",
      width: 150,
      render: (r) => (
        <span className="lyx-cell-2">
          {status(r.qualificationStatus, "store.qualification_status")}
          <span className="lyx-cell-2__sub">{status(r.sourceType, "entity.source_type")}</span>
        </span>
      ),
    },
    {
      key: "plan",
      title: "套餐 / 到期",
      width: 170,
      render: (r) => (
        <span className="lyx-cell-2">
          {text(r.subscription.plan?.name)} ·{" "}
          {status(r.subscription.status, "subscription_term.status")}
          <span className="lyx-cell-2__sub">
            {text(r.subscription.endDate)}
            {r.subscription.isRefundPending ? " · 退款处理中" : ""}
          </span>
        </span>
      ),
    },
    { key: "manager", title: "交付经理", width: 120, render: (r) => text(r.deliveryManager?.name) },
    {
      key: "paid",
      title: "主体付费",
      width: 130,
      align: "right",
      sortField: "totalPaidFen",
      render: (r) => (r.totalPaidFen === null ? "仅主店汇总" : amount(r.totalPaidFen)),
    },
    {
      key: "order",
      title: "最近订单",
      width: 170,
      sortField: "lastOrderAt",
      render: (r) => moment(r.lastOrderAt),
    },
    {
      key: "registered",
      title: "注册时间",
      width: 170,
      sortField: "registeredAt",
      render: (r) => moment(r.registeredAt),
    },
  ];
  return (
    <>
      <PageHeader
        title="商家列表"
        subtitle="当前可见范围内的门店、主体与服务事实"
        extra={
          <a className="lyx-link" href="/merchants/referral-codes">
            渠道码登记
          </a>
        }
      />
      <section className="lyx-card lyx-merchant-summary" aria-label="商家汇总">
        {summary.isPending ? (
          "汇总加载中…"
        ) : summary.isError ? (
          <Alert
            type="error"
            title={summary.error.message}
            action={<Button onClick={() => void summary.refetch()}>重试</Button>}
          />
        ) : summary.data ? (
          <>
            {[
              ["可见门店", summary.data.total],
              ["已付费", summary.data.paidCount],
              ["有效套餐", summary.data.activePlanCount],
              ["待资质审核", summary.data.pendingReviewCount],
              ["本月新增", summary.data.newThisMonthCount],
            ].map(([label, value]) => (
              <span key={label}>
                {label} <strong>{value}</strong>
              </span>
            ))}
          </>
        ) : (
          "暂无汇总"
        )}
      </section>
      <QueryTablePage
        label="商家列表"
        search={readTableSearch(
          search,
          STORE_KEYS.filter((key) => !["q", "page", "pageSize", "sort"].includes(key)),
        )}
        onSearchChange={(next) => change(writeTableSearch(next))}
        keywordPlaceholder="搜索门店或主体名称"
        columns={columns}
        rowKey={(r) => r.storeId}
        onRowClick={(r) =>
          void navigate({
            to: "/merchants/$storeId",
            params: { storeId: r.storeId },
            search: { tab: "profile" },
          })
        }
        query={
          rows.isPending
            ? { status: "loading" }
            : rows.isError
              ? { status: "error", message: rows.error.message }
              : { status: "success", items: rows.data?.items ?? [], total: rows.data?.total ?? 0 }
        }
        refreshing={rows.isFetching}
        onRetry={() => void rows.refetch()}
        filters={[
          {
            key: "lifecycle",
            placeholder: "门店状态",
            options: [
              { value: "active", label: "在用" },
              { value: "archived", label: "已归档" },
            ],
          },
          {
            key: "qualificationStatus",
            placeholder: "资质状态",
            options: QUALIFICATION_STATUS.values.map((value) => ({
              value,
              label: status(value, "store.qualification_status"),
            })),
          },
          {
            key: "sourceType",
            placeholder: "来源",
            options: SOURCE_TYPE.values.map((value) => ({
              value,
              label: status(value, "entity.source_type"),
            })),
          },
          {
            key: "subscriptionStatus",
            placeholder: "套餐状态",
            options: [
              { value: "none", label: "未开通" },
              { value: "active", label: "有效" },
              { value: "expired", label: "已到期" },
            ],
          },
          {
            key: "expiresWithinDays",
            placeholder: "近期到期",
            options: [
              { value: "7", label: "7 天内" },
              { value: "30", label: "30 天内" },
            ],
          },
          {
            key: "isManagerUnassigned",
            placeholder: "经理分配",
            options: [{ value: "true", label: "未分配" }],
          },
        ]}
        toolbar={
          <Button
            onClick={() => {
              setDraft(search);
              setEditing(true);
            }}
          >
            更多筛选
          </Button>
        }
        empty={{ title: "暂无可见商家", filteredTitle: "没有符合条件的商家" }}
      />
      <Modal
        open={editing}
        title="更多商家筛选"
        onCancel={() => setEditing(false)}
        onOk={() => {
          change({
            ...search,
            ...draft,
            page: 1,
            ...(draft.deliveryManagerId ? { isManagerUnassigned: undefined } : {}),
          });
          setEditing(false);
        }}
        okText="应用筛选"
        cancelText="取消"
        destroyOnHidden
      >
        <p>代码与 ID 可从当前已授权记录复制；空白表示不限。无效值按正式查询契约清除。</p>
        {advanced.map(([key, label]) => (
          <FormField key={key} label={label}>
            {(field) => (
              <Input
                {...field}
                value={draft[key] ?? ""}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              />
            )}
          </FormField>
        ))}
        <FormField label="排序">
          {(field) => (
            <Select
              {...field}
              style={{ width: "100%" }}
              value={draft.sort ?? "-lastOrderAt"}
              options={[
                ["-lastOrderAt", "最近订单优先"],
                ["-totalPaidFen", "主体付费从高到低"],
                ["-createdAt", "创建时间倒序"],
                ["-registeredAt", "注册时间倒序"],
                ["registeredAt", "注册时间正序"],
              ].map(([value, label]) => ({ value, label }))}
              onChange={(value) => setDraft({ ...draft, sort: value })}
            />
          )}
        </FormField>
      </Modal>
    </>
  );
}
