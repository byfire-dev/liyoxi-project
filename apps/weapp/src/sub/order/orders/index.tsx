import { useEffect, useRef, useState } from "react";
import { View } from "@tarojs/components";
import Taro, { useReachBottom } from "@tarojs/taro";
import { formatInteger } from "@liyoxi/shared/format/money";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Empty } from "@/components/Empty";
import { ListFooter } from "@/components/ListFooter";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag, merchantStatusByEnum } from "@/components/StatusTag";
import { Tabs } from "@/components/Tabs";
import { account } from "@/lib/account-runtime";
import { catalogScope, viewerRole } from "@/stores/catalog";
import { useContextStore } from "@/stores/context";
import { mergeOrders, ORDER_TABS, type OrderPage, type OrderTab } from "@/stores/order";
import { useSessionStore } from "@/stores/session";
import { orderApi } from "../private/api";
import { useOrderResource } from "../private/resource";
import "./index.scss";
export default function OrdersPage() {
  const rev = useContextStore((s) => s.contextRev),
    token = useSessionStore((s) => s.accessToken);
  return <Orders key={`${rev}:${token}`} />;
}
function Orders() {
  const [tab, setTab] = useState<OrderTab>("all"),
    [page, setPage] = useState<OrderPage | null>(null),
    [more, setMore] = useState(false),
    [moreError, setMoreError] = useState<string | null>(null);
  const paging = useRef<object | null>(null);
  const resource = useOrderResource(
    async () =>
      viewerRole(account.snapshot().me, catalogScope()) === "owner" ? orderApi.list(tab) : null,
    tab,
  );
  const loaded = resource.data,
    initialLoading = resource.loading,
    guard = resource.guard;
  useEffect(() => {
    paging.current = null;
    const current = guard(true);
    void Promise.resolve().then(() => {
      if (!current()) return;
      setMore(false);
      setMoreError(null);
      if (!initialLoading) setPage(loaded);
    });
  }, [loaded, initialLoading, guard]);
  const loadMore = async () => {
    if (paging.current || resource.loading || !page?.hasMore || !page.nextCursor) return;
    const own = {},
      current = resource.guard(true),
      cursor = page.nextCursor;
    paging.current = own;
    setMore(true);
    setMoreError(null);
    try {
      const next = await orderApi.list(tab, cursor);
      if (current() && paging.current === own)
        setPage((previous) => (previous ? mergeOrders(previous, next) : next));
    } catch (e: unknown) {
      if (current() && paging.current === own)
        setMoreError(e instanceof Error ? e.message : "加载失败，请重试");
    } finally {
      if (current() && paging.current === own) {
        paging.current = null;
        setMore(false);
      }
    }
  };
  useReachBottom(() => {
    void loadMore();
  });
  const pick = (value: OrderTab) => {
    resource.invalidate();
    paging.current = null;
    setPage(null);
    setMore(false);
    setMoreError(null);
    setTab(value);
  };
  return (
    <View className="orders-page" id={resource.loading ? undefined : "order-ready"}>
      <Tabs sticky items={ORDER_TABS} value={tab} onChange={pick} />
      <PageBody>
        {resource.error ? (
          <LoadError
            message={resource.error}
            onRetry={resource.refresh}
            retrying={resource.loading}
          />
        ) : null}
        {!page && resource.loading ? (
          <Skeleton cards={3} />
        ) : !page || !page.items.length ? (
          <Empty
            title={!page && !resource.error ? "仅老板可查看订单" : "暂无订单"}
            description="订购完成后可在这里查看交付进度"
            actionText="去选剧"
            onAction={() => {
              void Taro.switchTab({ url: "/pages/mall/index" });
            }}
          />
        ) : (
          <>
            {page.items.map((item) => {
              const tone = merchantStatusByEnum("drama_order.status", item.status);
              return (
                <Card key={item.orderId}>
                  <View className="orders-page__head">
                    <View>{item.orderNo}</View>
                    {tone ? (
                      <StatusTag plain tone={tone.tone}>
                        {tone.label}
                      </StatusTag>
                    ) : null}
                  </View>
                  <View className="orders-page__muted">
                    {appDateTimeFormat.dateTime(item.submittedAt)}
                  </View>
                  <View className="orders-page__row">
                    <View>
                      <View className="orders-page__title">
                        {item.firstDramaTitle}
                        {item.itemCount > 1 ? ` 等 ${item.itemCount} 部` : ""}
                      </View>
                      <View className="orders-page__muted">
                        整部定制 ·{" "}
                        {item.platforms
                          .map((p) =>
                            p === "douyin" ? "抖音" : p === "wechat_channels" ? "视频号" : p,
                          )
                          .join("、")}
                      </View>
                    </View>
                    <View className="orders-page__points">
                      {formatInteger(item.totalChargePoints)} 积分
                    </View>
                  </View>
                  {item.pinnedTodo ? <Note>{item.pinnedTodo.title}</Note> : null}
                  {item.liveSummary ? (
                    <View className="orders-page__muted">
                      {item.liveSummary.liveItemCount} 部已上线，共{" "}
                      {item.liveSummary.liveEpisodeCount} 集 · 最早{" "}
                      {item.liveSummary.earliestUsageEndDate} 到期
                    </View>
                  ) : null}
                  <View className="orders-page__actions">
                    <Button
                      size="sm"
                      onClick={() => {
                        void Taro.navigateTo({
                          url: `/sub/order/order-detail/index?orderId=${encodeURIComponent(item.orderId)}`,
                        });
                      }}
                    >
                      查看进度
                    </Button>
                  </View>
                </Card>
              );
            })}
            {moreError ? (
              <LoadError
                message={moreError}
                onRetry={() => {
                  void loadMore();
                }}
                retrying={more}
              />
            ) : null}
            {more || !page.hasMore ? <ListFooter status={more ? "loading" : "done"} /> : null}
            {page.hasMore && !more ? (
              <Button
                block
                variant="outline"
                size="sm"
                onClick={() => {
                  void loadMore();
                }}
              >
                继续查看订单
              </Button>
            ) : null}
          </>
        )}
      </PageBody>
    </View>
  );
}
