import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Taro, { useDidShow, usePullDownRefresh, useReachBottom } from "@tarojs/taro";
import { View } from "@tarojs/components";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Cover } from "@/components/Cover";
import { DescList } from "@/components/DescList";
import { Empty } from "@/components/Empty";
import { ListFooter } from "@/components/ListFooter";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag, merchantStatusByEnum } from "@/components/StatusTag";
import { Tabs } from "@/components/Tabs";
import { account } from "@/lib/account-runtime";
import { deliveryScope, deliveryScopeKey } from "@/stores/delivery";
import { useDeliveryIdentity } from "../components/ui";
import { orderRequest } from "../private/api";
import { createMyDramasApi } from "./api";
import { createMyDramasModel, DRAMA_TABS } from "./model";
import "./index.scss";
export default function MyDramasPage() {
  const identity = useDeliveryIdentity();
  return <MyDramas key={identity} />;
}
function MyDramas() {
  const [model] = useState(() =>
    createMyDramasModel({
      api: createMyDramasApi(orderRequest),
      scope: deliveryScopeKey,
      allowed: () => Boolean(deliveryScope().token && deliveryScope().role === "owner"),
    }),
  );
  const state = useSyncExternalStore(model.subscribe, model.snapshot);
  const [startError, setStartError] = useState<string | null>(null),
    [booted, setBooted] = useState(false),
    active = useRef(true),
    shown = useRef(false);
  const refresh = useCallback(() => {
    const scope = deliveryScopeKey();
    setStartError(null);
    void account
      .start()
      .then(() => {
        if (active.current && scope === deliveryScopeKey()) return model.refresh();
      })
      .catch((error) => {
        if (active.current && scope === deliveryScopeKey())
          setStartError(error instanceof Error ? error.message : "暂时无法加载，请重试");
      })
      .finally(() => {
        if (active.current && scope === deliveryScopeKey()) setBooted(true);
        void Taro.stopPullDownRefresh();
      });
  }, [model]);
  useEffect(() => {
    active.current = true;
    model.mount();
    void Promise.resolve().then(() => {
      if (active.current) refresh();
    });
    return () => {
      active.current = false;
      model.dispose();
    };
  }, [model, refresh]);
  useDidShow(() => {
    if (shown.current) refresh();
    shown.current = true;
  });
  usePullDownRefresh(refresh);
  useReachBottom(() => {
    void model.more();
  });
  return (
    <View className="my-dramas" id={booted && !state.loading ? "my-dramas-ready" : undefined}>
      <Tabs
        sticky
        items={DRAMA_TABS.map((tab) => ({ ...tab, badge: state.summary?.[tab.key] }))}
        value={state.tab}
        onChange={(tab) => {
          void model.refresh(tab);
        }}
      />
      <PageBody>
        {state.error || startError ? (
          <LoadError
            message={state.error ?? startError!}
            retrying={state.loading || state.paging}
            onRetry={() => {
              if (state.page) void model.more();
              else refresh();
            }}
          />
        ) : null}
        {!booted || state.loading ? (
          <Skeleton cards={3} />
        ) : !state.page?.items.length ? (
          <Empty
            title={deliveryScope().role === "owner" ? "暂无短剧" : "仅老板可查看短剧"}
            description="订购后可在这里查看每部短剧的交付与使用情况"
          />
        ) : (
          state.page.items.map((item) => {
            const status = merchantStatusByEnum("order_item.phase", item.phase);
            return (
              <Card key={item.orderItemId}>
                <View className="my-dramas__row">
                  <Cover variant="thumb" title={item.dramaTitle} src={item.posterUrl?.url} />
                  <View>
                    <View className="my-dramas__title">{item.dramaTitle}</View>
                    {status ? (
                      <StatusTag plain tone={status.tone}>
                        {status.label}
                      </StatusTag>
                    ) : null}
                    <View className="my-dramas__muted">
                      整部 {item.episodeCount} 集 · 已上线 {item.liveEpisodeCount} 集
                    </View>
                  </View>
                </View>
                <DescList
                  items={[
                    {
                      label: "发布账号",
                      value:
                        item.accounts
                          .map(
                            (a) =>
                              `${a.platform === "douyin" ? "抖音" : a.platform === "wechat_channels" ? "视频号" : a.platform} · ${a.accountName}`,
                          )
                          .join("、") || "—",
                    },
                    {
                      label: "使用期",
                      value: `${item.usageStartDate ?? "上线首日"} 至 ${item.usageEndDate ?? "待确认"}`,
                    },
                    {
                      label: "剩余天数",
                      value: item.remainingDays === null ? "待上线" : `${item.remainingDays} 天`,
                    },
                    { label: "约定上线", value: item.agreedLaunchDate ?? "待确认" },
                    { label: "订单号", value: item.orderNo },
                  ]}
                />
                {item.pendingTodo ? <Note>{item.pendingTodo.title}</Note> : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const scope = deliveryScopeKey();
                    void model.openItem(item.orderItemId).then((orderId) => {
                      if (orderId && active.current && scope === deliveryScopeKey())
                        void Taro.navigateTo({
                          url: `/sub/order/order-detail/index?orderId=${encodeURIComponent(orderId)}`,
                        });
                    });
                  }}
                >
                  查看订单与交付
                </Button>
              </Card>
            );
          })
        )}
        {state.page?.hasMore ? (
          <Button
            block
            variant="outline"
            loading={state.paging}
            disabled={state.loading}
            onClick={() => {
              void model.more();
            }}
          >
            继续查看短剧
          </Button>
        ) : state.page?.items.length ? (
          <ListFooter status="done" />
        ) : null}
      </PageBody>
    </View>
  );
}
