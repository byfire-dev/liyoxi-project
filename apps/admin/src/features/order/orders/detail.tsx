import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext, useRouterState } from "@tanstack/react-router";
import { Button } from "antd";
import { DetailPage } from "../../../components/DetailPage";
import { InfoList } from "../../../components/InfoList";
import { EmptyState, ErrorState } from "../../../components/StateBlock";
import { StatusTag } from "../../../components/StatusTag";
import { DETAIL_QUERY } from "../../../lib/query";
import { createOrdersApi, type OrderDetail } from "./api";
import { models, platforms, ORDERS_KEY, resolveOrderNo, historyOrderId } from "./model";
import { OrderStatus } from "./list";
import "./orders.css";
const route = getRouteApi("/orders/$orderNo");
function OrderContent({ data }: { data: OrderDetail }) {
  return (
    <div className="lyx-order-sections">
      <section>
        <h2 className="lyx-section-title">剧目明细</h2>
        <div className="lyx-order-items">
          {data.items.map((item) => {
            const tone =
              statusToneByEnum("order_item.phase", item.phase)?.admin ??
              statusToneByEnum("drama_order.status", item.phase)?.admin ??
              (item.phase === "terminated"
                ? statusToneByEnum("delivery_ticket.step", "terminated")?.admin
                : undefined);
            return (
              <article key={item.orderItemId} className="lyx-order-item">
                <div className="lyx-order-item__title">
                  <strong>{item.dramaTitle}</strong>
                  {tone ? <StatusTag tone={tone.tone}>{tone.label}</StatusTag> : "其他阶段"}
                </div>
                <InfoList
                  items={[
                    {
                      label: "剧集",
                      value: `${item.episodeCount} 集 · ${models[item.productionModel] ?? item.productionModel}`,
                    },
                    {
                      label: "发布账号",
                      value:
                        item.accounts
                          .map((a) => `${platforms[a.platform] ?? a.platform} ${a.accountName}`)
                          .join("、") || "—",
                    },
                    {
                      label: "使用期",
                      value: `${item.usageStartDate ? date.date(item.usageStartDate) : "上线首日"} 至 ${date.date(item.usageEndDate)}`,
                    },
                    { label: "应扣积分", value: item.chargePoints.toLocaleString("zh-CN") },
                    {
                      label: "交付工单",
                      value: item.ticket
                        ? `${item.ticket.ticketNo} · ${statusToneByEnum("delivery_ticket.step", item.ticket.step)?.admin?.label ?? item.ticket.step}`
                        : "尚未开工",
                    },
                    {
                      label: "上线安排",
                      value: item.agreedLaunchDate ? date.date(item.agreedLaunchDate) : "待确认",
                    },
                  ]}
                  labelWidth={84}
                />
              </article>
            );
          })}
        </div>
      </section>
      <section>
        <h2 className="lyx-section-title">定制需求</h2>
        <InfoList
          items={[
            { label: "定制重点", value: data.focus.map((f) => f.name).join("、") || "—" },
            { label: "补充说明", value: data.note ?? "—" },
            {
              label: "约定上线",
              value: data.expectedLaunchDate ? date.date(data.expectedLaunchDate) : "待确认",
            },
            {
              label: "交付方案",
              value: data.deliveryPlan
                ? `${data.deliveryPlan.confirmedVersionNo !== null ? `已确认第 ${data.deliveryPlan.confirmedVersionNo} 版` : "尚未确认"}`
                : "开工后生成",
            },
          ]}
          labelWidth={84}
        />
      </section>
      <section>
        <h2 className="lyx-section-title">协议</h2>
        {data.agreements.length ? (
          data.agreements.map((a) => (
            <div className="lyx-order-agreement" key={`${a.agreementKey}-${a.versionLabel}`}>
              <strong>
                {a.title} · {a.versionLabel}
              </strong>
              <span>{date.dateTime(a.consentedAt)} 已签署</span>
            </div>
          ))
        ) : (
          <p>暂无协议记录</p>
        )}
      </section>
    </div>
  );
}
export function OrderDetailPage() {
  const { services } = useRouteContext({ from: "__root__" }),
    { orderNo } = route.useParams(),
    navigate = route.useNavigate();
  const api = createOrdersApi(services);
  const state = useRouterState({ select: (router) => router.location.state });
  const navigation =
    typeof window === "undefined"
      ? undefined
      : window.performance.getEntriesByType("navigation")[0];
  const reloaded = navigation !== undefined && "type" in navigation && navigation.type === "reload";
  const navigationId = reloaded ? undefined : historyOrderId(state, orderNo);
  const detail = useQuery({
    queryKey: [...ORDERS_KEY, "detail", orderNo],
    queryFn: async () => {
      const id = navigationId ?? (await resolveOrderNo(api, orderNo));
      if (!id) return null;
      const result = await api.detail(id);
      return result.orderNo === orderNo ? result : null;
    },
    ...DETAIL_QUERY,
  });
  if (detail.isError)
    return <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />;
  if (!detail.isPending && !detail.data)
    return <EmptyState title="没有找到这张订购单" description="请核对订单号，或回到订购单列表" />;
  const data = detail.data;
  return (
    <DetailPage
      title={`订购单 ${orderNo}`}
      state={detail.isPending ? { status: "loading" } : { status: "ready" }}
      onRetry={() => void detail.refetch()}
      activeTab="detail"
      onTabChange={() => {}}
      tags={data ? <OrderStatus row={data} /> : undefined}
      subtitle={
        data
          ? `${data.store.storeName ?? "未命名门店"} · ${date.dateTimeFull(data.submittedAt)} 下单 · 共 ${data.itemCount} 部剧 · 应扣 ${data.totalChargePoints.toLocaleString("zh-CN")} 积分`
          : undefined
      }
      actions={
        <Button size="large" onClick={() => void navigate({ to: "/orders" })}>
          返回订购单
        </Button>
      }
      progress={
        data ? (
          <section className="lyx-card lyx-order-progress" aria-label="订单进度">
            <div>
              <strong>提交订购</strong>
              <span>{date.dateTime(data.submittedAt)}</span>
            </div>
            <div>
              <strong>开始制作</strong>
              <span>{data.startedAt ? date.dateTime(data.startedAt) : "待开工"}</span>
            </div>
            <div>
              <strong>当前状态</strong>
              <OrderStatus row={data} />
            </div>
            <div>
              <strong>订单结束</strong>
              <span>{data.closedAt ? date.dateTime(data.closedAt) : "尚未结束"}</span>
            </div>
          </section>
        ) : undefined
      }
      tabs={[
        { key: "detail", label: "订单信息", content: data ? <OrderContent data={data} /> : null },
      ]}
      aside={
        data
          ? [
              {
                key: "points",
                title: "积分明细",
                content: (
                  <>
                    <InfoList
                      items={[
                        {
                          label: "剧目积分",
                          value: data.pointsBreakdown.listPriceTotalPoints.toLocaleString("zh-CN"),
                        },
                        {
                          label: "折扣差额",
                          value: data.pointsBreakdown.discountDeltaPoints.toLocaleString("zh-CN"),
                        },
                        {
                          label: "模型加扣",
                          value: data.pointsBreakdown.surchargeDeltaPoints.toLocaleString("zh-CN"),
                        },
                        {
                          label: "应扣积分",
                          value: (
                            <strong>
                              {data.pointsBreakdown.totalChargePoints.toLocaleString("zh-CN")}
                            </strong>
                          ),
                        },
                        {
                          label: "扣减来源",
                          value: `套餐 ${data.pointsBreakdown.planPoints.toLocaleString("zh-CN")} · 加购 ${data.pointsBreakdown.addonPoints.toLocaleString("zh-CN")}`,
                        },
                        {
                          label: "所属周期",
                          value: date.dateRange(
                            data.subscriptionTerm.startDate,
                            data.subscriptionTerm.endDate,
                          ),
                        },
                      ]}
                      labelWidth={84}
                    />
                    <div className="lyx-order-ledger">
                      {data.pointsEvents.map((event, index) => (
                        <p key={`${String(event.opType)}-${event.occurredAt}-${index}`}>
                          {date.dateTime(event.occurredAt)} ·{" "}
                          {event.opType === "hold"
                            ? "冻结"
                            : event.opType === "capture"
                              ? "扣减"
                              : String(event.opType)}{" "}
                          {event.points.toLocaleString("zh-CN")} 积分
                        </p>
                      ))}
                    </div>
                  </>
                ),
              },
              {
                key: "merchant",
                title: "商家与负责人",
                content: (
                  <InfoList
                    items={[
                      { label: "商家", value: data.store.storeName ?? "—" },
                      { label: "经营主体", value: data.store.entityName ?? "—" },
                      {
                        label: "联系人",
                        value: `${data.merchant.contactName ?? "—"} ${data.merchant.contactPhoneMask ?? ""}`,
                      },
                      { label: "当前套餐", value: data.merchant.currentPlanName ?? "—" },
                      {
                        label: "可用积分",
                        value: data.merchant.spendablePoints.toLocaleString("zh-CN"),
                      },
                      { label: "交付经理", value: data.deliveryManager?.name ?? "未分配" },
                    ]}
                    labelWidth={84}
                  />
                ),
              },
            ]
          : []
      }
    />
  );
}
