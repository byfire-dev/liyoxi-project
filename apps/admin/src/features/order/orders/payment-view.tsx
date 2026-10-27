import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import {
  Alert,
  Button,
  Drawer,
  Input,
  Modal,
  Select,
  Skeleton,
  Table,
  type TableProps,
} from "antd";
import { useContext, useMemo, useState } from "react";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { PageHeader } from "../../../components/PageHeader";
import { Tabs } from "../../../components/Tabs";
import { DateRangeField } from "../../../components/DateRangeField";
import { ErrorState } from "../../../components/StateBlock";
import { AccessContext, canAction } from "../../../lib/permissions";
import { LIST_QUERY, DETAIL_QUERY } from "../../../lib/query";
import { showSuccessNotice } from "../../../app/feedback";
import { billingScope, moneyText } from "../../billing/plans/model";
import { OfflinePaymentDialog } from "../offline-payment";
import { ProofDialog } from "../offline-payment/proof";
import { createPaymentOrdersApi, type PaymentRow } from "./payment-api";
import {
  paymentSearch,
  paymentFilters,
  paymentQuery,
  paymentStatus,
  paymentTypes,
  paymentTabs,
} from "./payment-model";
import { PaymentDetailPanel } from "./payment-detail";
import "../../billing/plans/billing.css";
const route = getRouteApi("/orders");
export function PaymentOrdersView() {
  return <PaymentWorkspace key={billingScope(useContext(AccessContext))} />;
}
function PaymentWorkspace() {
  const { services } = useRouteContext({ from: "__root__" }),
    access = useContext(AccessContext),
    scope = billingScope(access),
    raw = route.useSearch(),
    search = paymentSearch(raw),
    navigate = route.useNavigate(),
    api = useMemo(() => createPaymentOrdersApi(services), [services]),
    badRange = !!search.payFrom && !!search.payTo && search.payFrom > search.payTo;
  const list = useQuery({
      queryKey: ["order", scope, "payment-list", paymentQuery(search)],
      queryFn: ({ signal }) => api.list(paymentQuery(search), signal),
      enabled: !badRange,
      ...LIST_QUERY,
    }),
    summary = useQuery({
      queryKey: ["order", scope, "payment-summary", paymentFilters(search)],
      queryFn: ({ signal }) => api.summary(paymentFilters(search), signal),
      enabled: !badRange,
      ...DETAIL_QUERY,
    }),
    detail = useQuery({
      queryKey: ["order", scope, "payment", search.paymentId],
      queryFn: ({ signal }) => api.detail(search.paymentId!, signal),
      enabled: !!search.paymentId,
      ...DETAIL_QUERY,
    });
  const [creating, setCreating] = useState(false),
    [createdPaymentId, setCreatedPaymentId] = useState<string>(),
    [proofId, setProofId] = useState<string>();
  const canUpload = canAction(access, "finance.receipt.confirm"),
    change = (patch: Record<string, unknown>) =>
      void navigate({ search: { ...raw, ...paymentSearch({ ...search, ...patch }) } }),
    refresh = () => {
      void list.refetch();
      void summary.refetch();
      if (search.paymentId) void detail.refetch();
    };
  const columns: NonNullable<TableProps<PaymentRow>["columns"]> = [
    {
      key: "no",
      title: "付款单号 / 建立",
      render: (_, r) => (
        <span>
          <Button type="link" size="small" onClick={() => change({ paymentId: r.paymentOrderId })}>
            {r.orderNo}
          </Button>
          <br />
          {appDateTimeFormat.dateTimeFull(r.createdAt)}
        </span>
      ),
    },
    {
      key: "entity",
      title: "主体 / 内容",
      render: (_, r) => (
        <div className="lyx-cell-2">
          <strong>{r.entity.name}</strong>
          <span>
            {r.store?.name ?? "主体"} · {r.title}
          </span>
          <span className="lyx-cell-2__sub">
            {paymentTypes[r.type] ?? r.type} · {r.source === "admin" ? "后台" : "商家端"}
          </span>
        </div>
      ),
    },
    {
      key: "amount",
      title: "应付 / 实付 / 已退",
      align: "right",
      render: (_, r) => (
        <span>
          {moneyText(r.amountFen)}
          <br />
          {moneyText(r.paidAmountFen)} / {moneyText(r.refundedAmountFen)}
        </span>
      ),
    },
    {
      key: "status",
      title: "状态",
      render: (_, r) => (
        <span>
          {paymentStatus[r.status] ?? r.status}
          <br />
          {r.channel === "bank_transfer"
            ? "对公转账"
            : r.channel === "wechat_jsapi"
              ? "微信支付"
              : r.channel}
          <br />
          {r.statusNote ?? r.fulfillmentStatus}
          {r.hasOpenException ? " · 有异常" : ""}
        </span>
      ),
    },
    {
      key: "actions",
      title: "操作",
      render: (_, r) => (
        <div className="billing-actions">
          <Button size="small" onClick={() => change({ paymentId: r.paymentOrderId })}>
            详情
          </Button>
          {canUpload && r.actions.includes("submit-proof") ? (
            <Button size="small" onClick={() => setProofId(r.paymentOrderId)}>
              代传凭证
            </Button>
          ) : null}
        </div>
      ),
    },
  ];
  return (
    <div className="billing-stack">
      <PageHeader
        title="付款单"
        subtitle="套餐、积分包独立付款单；与短剧订购单分开读取。"
        extra={
          canAction(access, "order.payment.create_offline") ? (
            <Button type="primary" onClick={() => setCreating(true)}>
              线下开单
            </Button>
          ) : undefined
        }
      />
      {summary.isError ? <ErrorState onRetry={() => void summary.refetch()} /> : null}
      <section className="lyx-card billing-panel billing-stack">
        <Tabs
          label="付款状态"
          activeKey={search.payTab}
          items={paymentTabs.map((key) => ({
            key,
            label: paymentStatus[key]!,
            count: summary.data?.[key],
          }))}
          onChange={(payTab) => change({ payTab, payPage: 1 })}
        />
        <div className="billing-actions">
          <Input.Search
            aria-label="搜索付款单"
            placeholder="单号、主体或门店"
            defaultValue={search.payQ}
            allowClear
            onSearch={(payQ) => change({ payQ, payPage: 1 })}
          />
          <Input.Search
            aria-label="精确付款单号"
            placeholder="精确单号"
            defaultValue={search.payNo}
            onSearch={(payNo) => change({ payNo, payPage: 1 })}
          />
          <Select
            aria-label="付款内容类型"
            mode="multiple"
            value={search.payType?.split(",") ?? []}
            placeholder="全部类型"
            options={Object.entries(paymentTypes).map(([value, label]) => ({ value, label }))}
            onChange={(values) =>
              change({ payType: values.length ? values.join(",") : undefined, payPage: 1 })
            }
          />
          <Select
            aria-label="付款渠道"
            value={search.payChannel}
            allowClear
            placeholder="全部渠道"
            options={[
              { value: "bank_transfer", label: "对公转账" },
              { value: "wechat_jsapi", label: "微信支付" },
            ]}
            onChange={(payChannel) => change({ payChannel, payPage: 1 })}
          />
          <Select
            aria-label="付款来源"
            value={search.paySource}
            allowClear
            placeholder="全部来源"
            options={[
              { value: "admin", label: "后台" },
              { value: "weapp", label: "商家端" },
            ]}
            onChange={(paySource) => change({ paySource, payPage: 1 })}
          />
          <Select
            aria-label="付款异常"
            value={search.payException}
            allowClear
            placeholder="全部异常状态"
            options={[
              { value: "true", label: "有未结异常" },
              { value: "false", label: "无未结异常" },
            ]}
            onChange={(payException) => change({ payException, payPage: 1 })}
          />
          <DateRangeField
            key={`${search.payFrom}:${search.payTo}`}
            aria-label="付款建立日期"
            onChange={(r) =>
              change({
                payFrom: r?.[0]?.format("YYYY-MM-DD"),
                payTo: r?.[1]?.format("YYYY-MM-DD"),
                payPage: 1,
              })
            }
          />
          {search.payFrom || search.payTo ? (
            <span>
              {search.payFrom ?? "不限"} 至 {search.payTo ?? "不限"}
            </span>
          ) : null}
          <Input.Search
            aria-label="筛选付款主体ID"
            placeholder="主体ID（选填）"
            defaultValue={search.payEntityId}
            onSearch={(payEntityId) => change({ payEntityId, payPage: 1 })}
          />
          <Input.Search
            aria-label="筛选付款门店ID"
            placeholder="门店ID（选填）"
            defaultValue={search.payStoreId}
            onSearch={(payStoreId) => change({ payStoreId, payPage: 1 })}
          />
          <Select
            aria-label="付款排序"
            value={search.paySort}
            options={[
              { value: "-createdAt", label: "建立时间倒序" },
              { value: "-amountFen", label: "金额倒序" },
            ]}
            onChange={(paySort) => change({ paySort, payPage: 1 })}
          />
          <Button
            onClick={() =>
              change({ ...paymentSearch({ view: "payments" }), paymentId: search.paymentId })
            }
          >
            重置筛选
          </Button>
        </div>
        {badRange ? (
          <Alert role="alert" type="error" title="开始日期不能晚于结束日期" />
        ) : list.isPending ? (
          <Skeleton active />
        ) : list.isError ? (
          <ErrorState onRetry={refresh} />
        ) : (
          <div className="billing-table">
            <Table<PaymentRow>
              rowKey="paymentOrderId"
              columns={columns}
              dataSource={list.data.items}
              pagination={{
                current: search.payPage,
                pageSize: search.paySize,
                total: list.data.total,
                showSizeChanger: true,
                pageSizeOptions: [10, 20, 50],
                onChange: (payPage, paySize) => change({ payPage, paySize }),
              }}
              locale={{ emptyText: "暂无符合条件的付款单" }}
            />
          </div>
        )}
      </section>
      <Drawer
        open={!!search.paymentId}
        title="独立付款单详情"
        width={800}
        onClose={() => change({ paymentId: undefined })}
      >
        {detail.isPending ? (
          <Skeleton active />
        ) : detail.isError ? (
          <ErrorState onRetry={() => void detail.refetch()} />
        ) : detail.data ? (
          <PaymentDetailPanel key={detail.data.paymentOrderId} row={detail.data} />
        ) : null}
      </Drawer>
      {creating ? (
        <OfflinePaymentDialog
          services={services}
          scope={scope}
          canUpload={canUpload}
          onClose={() => {
            setCreating(false);
            if (createdPaymentId) {
              change({ paymentId: createdPaymentId });
              setCreatedPaymentId(undefined);
            }
          }}
          onCreated={(row) => {
            showSuccessNotice("待付款单已建立，尚未收款");
            // 先完成当前代传弹层；详情Drawer稍后打开，避免后挂载的遮罩抢走提交入口。
            setCreatedPaymentId(row.paymentOrderId);
            refresh();
          }}
          onProofSaved={() => {
            showSuccessNotice("凭证已提交收款审核");
            refresh();
          }}
        />
      ) : null}
      {proofId ? (
        <OpenProof
          key={proofId}
          id={proofId}
          scope={scope}
          onClose={() => setProofId(undefined)}
          onSaved={() => {
            showSuccessNotice("凭证已提交收款审核");
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}
function OpenProof({
  id,
  scope,
  onClose,
  onSaved,
}: {
  id: string;
  scope: string;
  onClose(): void;
  onSaved(): void;
}) {
  const { services } = useRouteContext({ from: "__root__" }),
    access = useContext(AccessContext),
    api = createPaymentOrdersApi(services),
    detail = useQuery({
      queryKey: ["order", scope, "proof-order", id],
      queryFn: ({ signal }) => api.detail(id, signal),
    });
  return detail.data ? (
    <ProofDialog
      order={detail.data}
      api={api}
      services={services}
      scope={scope}
      canUpload={canAction(access, "finance.receipt.confirm")}
      onClose={onClose}
      onSaved={onSaved}
    />
  ) : (
    <Modal
      open
      title="读取付款单"
      footer={<Button onClick={onClose}>关闭</Button>}
      onCancel={onClose}
    >
      {detail.isError ? <ErrorState onRetry={() => void detail.refetch()} /> : <Skeleton active />}
    </Modal>
  );
}
