import { View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { formatInteger } from "@liyoxi/shared/format/money";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Cover } from "@/components/Cover";
import { DescList } from "@/components/DescList";
import { Empty } from "@/components/Empty";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag, merchantStatusByEnum } from "@/components/StatusTag";
import { TextButton } from "@/components/TextButton";
import { Timeline } from "@/components/Timeline";
import { account } from "@/lib/account-runtime";
import { catalogScope, viewerRole } from "@/stores/catalog";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { orderApi } from "../private/api";
import { useOrderResource } from "../private/resource";
import { OrderReferenceRead } from "../private/reference-ui";
import { deliveryEntry, deliveryItemEntries } from "../components/navigation";
import { formatOrderTimelineTime } from "./timeline";
import "./index.scss";
const timelineNames: Record<string, string> = {
  submitted: "已订购（积分冻结）",
  started: "开始制作（积分扣减）",
  manager_assigned: "服务经理已对接",
  plan_confirmed: "交付方案已确认",
  sample_confirmed: "样片确认",
  delivered: "成片交付",
  live: "一次性上线",
  usage_ended: "使用期结束",
};
const actionNames: Record<string, string> = {
  "view-plan": "查看交付方案",
  "confirm-plan": "确认交付方案",
  "view-sample": "查看样片",
  "confirm-sample": "确认样片",
  "view-delivery": "查看成片交付",
  "view-launch": "查看发布任务",
  "view-launch-record": "查看上线记录",
};
const pointNames: Record<string, string> = {
  hold: "冻结",
  capture: "扣减",
  release: "释放",
  refund: "退回",
};
export default function OrderDetailPage() {
  const rev = useContextStore((s) => s.contextRev),
    token = useSessionStore((s) => s.accessToken);
  const id = Taro.getCurrentInstance().router?.params.orderId ?? "";
  return <Detail key={`${id}:${rev}:${token}`} id={id} />;
}
function Detail({ id }: { id: string }) {
  const resource = useOrderResource(
    async () =>
      id && viewerRole(account.snapshot().me, catalogScope()) === "owner"
        ? orderApi.detail(id)
        : null,
    id,
  );
  const order = resource.data;
  useSessionStore((state) => state.me);
  const owner = viewerRole(account.snapshot().me, catalogScope()) === "owner";
  const navigate = (action: string, itemId?: string) => {
    if (!order || viewerRole(account.snapshot().me, catalogScope()) !== "owner") return;
    const url = deliveryEntry(order, action, itemId);
    if (url) {
      void Taro.navigateTo({ url });
    } else void Taro.showToast({ title: "暂无交付内容", icon: "none" });
  };
  const tone = order ? merchantStatusByEnum("drama_order.status", order.status) : null;
  return (
    <View className="order-detail" id={resource.loading ? undefined : "order-ready"}>
      <PageBody>
        {resource.error ? (
          <LoadError
            message={resource.error}
            onRetry={resource.refresh}
            retrying={resource.loading}
          />
        ) : null}
        {!order && resource.loading ? (
          <Skeleton cards={3} />
        ) : !order ? (
          <Empty title="暂无订单详情" description="请从订单列表进入查看" />
        ) : (
          <>
            <Card title={tone ? <StatusTag tone={tone.tone}>{tone.label}</StatusTag> : "订单状态"}>
              {order.pendingTodo ? (
                <Note>{order.pendingTodo.title}</Note>
              ) : (
                <Note>下拉刷新可查看最新交付进度</Note>
              )}
              {order.actions
                .filter((a) => actionNames[a])
                .map((a) => (
                  <TextButton key={a} onClick={() => navigate(a)}>
                    {actionNames[a]}
                  </TextButton>
                ))}
            </Card>
            {order.items.map((item) => {
              const phase = merchantStatusByEnum("order_item.phase", item.phase);
              return (
                <Card key={item.orderItemId} title="剧目与交付进度">
                  <View className="order-detail__drama">
                    <Cover variant="thumb" title={item.dramaTitle} src={item.posterUrl?.url} />
                    <View>
                      <View className="order-detail__title">{item.dramaTitle}</View>
                      <View className="order-detail__muted">
                        整部 {item.episodeCount} 集 · {formatInteger(item.chargePoints)} 积分
                      </View>
                      {phase ? (
                        <StatusTag plain tone={phase.tone}>
                          {phase.label}
                        </StatusTag>
                      ) : null}
                    </View>
                  </View>
                  <DescList
                    labelWidth="lg"
                    items={[
                      {
                        label: "发布账号",
                        value:
                          item.accounts
                            .map(
                              (a) =>
                                `${a.platform === "douyin" ? "抖音" : "视频号"} · ${a.accountName}`,
                            )
                            .join("、") || "—",
                      },
                      { label: "约定上线", value: item.agreedLaunchDate ?? "待确认" },
                      {
                        label: "成片使用期",
                        value: `${item.usageStartDate ?? "上线首日"} 至 ${item.usageEndDate ?? "待确认"}`,
                      },
                      {
                        label: "已上线集数",
                        value: `${item.liveEpisodeCount}/${item.episodeCount}`,
                      },
                    ]}
                  />
                  <Timeline
                    items={item.timeline
                      .filter((t) => timelineNames[t.key])
                      .map((t) => ({
                        key: t.key,
                        title: timelineNames[t.key],
                        state:
                          t.state === "done" ? "done" : t.state === "current" ? "current" : "todo",
                        time: formatOrderTimelineTime(t.at),
                      }))}
                  />
                  {deliveryItemEntries(item, owner).map((action) => (
                    <TextButton key={action} onClick={() => navigate(action, item.orderItemId)}>
                      {actionNames[action]}
                    </TextButton>
                  ))}
                </Card>
              );
            })}
            {order.deliveryPlan ? (
              <Card title="交付方案">
                <DescList
                  items={[
                    {
                      label: "定制重点",
                      value: order.deliveryPlan.focus.map((f) => f.name).join("、") || "—",
                    },
                    { label: "约定上线", value: order.deliveryPlan.agreedLaunchDate ?? "待确认" },
                    {
                      label: "确认版本",
                      value:
                        order.deliveryPlan.confirmedVersionNo === null
                          ? "待确认"
                          : `第 ${order.deliveryPlan.confirmedVersionNo} 版`,
                    },
                  ]}
                />
                {order.deliveryPlan ? (
                  <TextButton onClick={() => navigate("view-plan")}>查看交付方案</TextButton>
                ) : null}
              </Card>
            ) : null}
            <Card title="订单信息">
              <DescList
                items={[
                  { label: "订单号", value: order.orderNo },
                  { label: "订购时间", value: appDateTimeFormat.dateTime(order.submittedAt) },
                  { label: "门店", value: order.storeName ?? "—" },
                  { label: "主体", value: order.entityName ?? "—" },
                  { label: "套餐", value: order.planName },
                  { label: "定制重点", value: order.focus.map((f) => f.name).join("、") || "—" },
                  { label: "补充说明", value: order.note ?? "—" },
                  { label: "合计积分", value: `${formatInteger(order.totalChargePoints)} 积分` },
                ]}
              />
            </Card>
            <OrderReferenceRead ids={order.referenceStoreAssetIds} />
            <Card title="积分记录">
              {order.pointsEvents.length ? (
                <Timeline
                  variant="record"
                  items={order.pointsEvents.map((event, i) => ({
                    key: String(i),
                    title: `${pointNames[event.opType] ?? event.opType} ${formatInteger(event.points)} 积分`,
                    time: appDateTimeFormat.dateTime(event.occurredAt),
                    description: `套餐积分 ${formatInteger(event.planPoints)} · 加量积分 ${formatInteger(event.addonPoints)}`,
                  }))}
                />
              ) : (
                <Note>暂无积分记录</Note>
              )}
            </Card>
            <Card title="已同意协议">
              {order.agreements.map((agreement) => (
                <View key={agreement.agreementVersionId}>
                  <TextButton
                    onClick={() => {
                      void Taro.navigateTo({
                        url: `/pages/agreement/index?id=${encodeURIComponent(agreement.agreementVersionId)}`,
                      });
                    }}
                  >
                    {agreement.name} {agreement.versionLabel}
                  </TextButton>
                  <View className="order-detail__muted">
                    {appDateTimeFormat.dateTime(agreement.consentedAt)}
                  </View>
                </View>
              ))}
            </Card>
            <Button
              block
              variant="outline"
              onClick={() => {
                void Taro.navigateTo({ url: "/sub/profile/service/index" });
              }}
            >
              联系服务经理
            </Button>
          </>
        )}
      </PageBody>
    </View>
  );
}
