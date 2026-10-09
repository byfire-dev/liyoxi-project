import { useState } from "react";
import { View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Avatar } from "@/components/Avatar";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Empty } from "@/components/Empty";
import { FilterChips } from "@/components/FilterChips";
import { List, ListRow } from "@/components/List";
import { ListFooter } from "@/components/ListFooter";
import { LoadError } from "@/components/LoadError";
import { PageBody } from "@/components/PageBody";
import { Sheet } from "@/components/Sheet";
import { Skeleton } from "@/components/Skeleton";
import { TextButton } from "@/components/TextButton";
import { gotoAccountLogin } from "@/lib/account-routing";
import { account } from "@/lib/account-runtime";
import { withSubscribe } from "@/lib/runtime";
import { currentMessageScope } from "@/stores/messages";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { MESSAGE_TABS, type Message } from "./api";
import { messagesApi, useMessagesResource } from "./resource";
import { messageTarget } from "./target";
import { settingsSubscription } from "./model";
import "./index.scss";

const labels = {
  all: "全部",
  order: "订单",
  delivery: "交付",
  launch: "上线",
  plan_points: "套餐/积分",
  review: "审核",
  store: "门店",
  service: "服务",
};
const settingLabels: Record<string, string> = {
  on: "已订阅",
  off: "未订阅",
  rejected: "已拒绝",
  banned: "已关闭",
  unavailable: "暂不可用",
};
export default function MessagesPage() {
  const token = useSessionStore((s) => s.accessToken);
  const { state, controller, scope } = useMessagesResource();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const toast = (title: string) => {
    void Taro.showToast({ title, icon: "none" });
  };
  const current = () => scope === currentMessageScope();
  const open = async (item: Message) => {
    if (!(await controller.read(item)) || !current()) return;
    const storeId = useContextStore.getState().currentStoreId;
    const owner =
      account
        .snapshot()
        .me?.memberships.some(
          (member) =>
            member.role === "owner" && member.stores.some((store) => store.storeId === storeId),
        ) ?? false;
    let target = messageTarget(item.link, { storeId, owner });
    if ("agreementKey" in target) {
      const key = target.agreementKey;
      try {
        const data = await messagesApi.agreement(key);
        if (!current()) return;
        const version = data.items.find((row) => row.agreementKey === key)?.currentVersion;
        target = version
          ? { url: `/pages/agreement/index?id=${encodeURIComponent(version.agreementVersionId)}` }
          : { notice: "当前协议暂不可访问，请稍后重试" };
      } catch {
        if (current()) toast("当前协议暂不可访问，请稍后重试");
        return;
      }
    }
    if (!current()) return;
    if ("notice" in target) return toast(target.notice);
    try {
      if (target.tab) await Taro.switchTab({ url: target.url });
      else await Taro.navigateTo({ url: target.url });
    } catch {
      if (current()) toast("该内容暂不可访问，消息仍会保留");
    }
  };
  const groups = new Map<string, Message[]>();
  state.items.forEach((item) =>
    groups.set(item.createdDate, [...(groups.get(item.createdDate) ?? []), item]),
  );
  const refreshSettings = async () => {
    if (current()) await controller.settings();
  };
  const subscribe = settingsSubscription(withSubscribe, refreshSettings, refreshSettings);
  return (
    <View
      className="messages-page"
      id={state.loaded && !state.loading && token ? "messages-ready" : undefined}
    >
      <PageBody>
        {!token ? (
          <Empty
            title="登录后查看消息"
            description="门店与账号消息会显示在这里"
            actionText="去登录"
            onAction={gotoAccountLogin}
          />
        ) : (
          <>
            <FilterChips
              className="messages-page__filters"
              items={MESSAGE_TABS.map((tab) => ({
                key: tab,
                label: labels[tab],
                count:
                  state.summary?.byTab.find((row) => row.tab === tab)?.unreadCount || undefined,
              }))}
              value={state.tab}
              onChange={(tab) => {
                void controller.select(tab);
              }}
            />
            <View className="messages-page__toolbar">
              <View>{state.summary ? `未读 ${state.summary.total} 条` : "未读数待更新"}</View>
              <TextButton
                className="messages-page__action"
                disabled={state.loading || state.writing || !state.items.length}
                onClick={() => {
                  void controller.batchRead();
                }}
              >
                {state.writing ? "正在标记" : "全部已读"}
              </TextButton>
            </View>
            {state.error ? (
              <LoadError
                message={state.error}
                onRetry={() => {
                  void controller.refresh();
                }}
              />
            ) : null}
            {state.loading || !state.loaded ? (
              <Skeleton cards={2} rows={3} />
            ) : state.items.length === 0 && !state.error ? (
              <Empty
                title={state.tab === "all" ? "暂无消息" : "没有这一类消息"}
                description="新消息到来后会显示在这里"
              />
            ) : (
              [...groups].map(([date, items]) => (
                <View key={date} className="messages-page__group">
                  <View className="messages-page__date">{date}</View>
                  <List>
                    {items.map((item) => (
                      <ListRow
                        key={item.messageId}
                        className={`messages-page__row${item.isRead ? "" : " messages-page__row--unread"}`}
                        media={
                          <View className="messages-page__avatar">
                            <Avatar
                              text={labels[item.category as keyof typeof labels] ?? "消息"}
                              size={36}
                            />
                            {!item.isRead ? <Badge dot /> : null}
                          </View>
                        }
                        title={
                          <View className="messages-page__title">
                            <View>{item.title}</View>
                            <View className="messages-page__time">
                              {appDateTimeFormat.dateTime(item.createdAt)}
                              <View>{item.isRead ? "已读" : "未读"}</View>
                            </View>
                          </View>
                        }
                        description={
                          <View>
                            <View className="messages-page__body">{item.body}</View>
                            {item.ctaText ? (
                              <View className="messages-page__cta">{item.ctaText}</View>
                            ) : null}
                          </View>
                        }
                        arrow={false}
                        onClick={() => {
                          void open(item);
                        }}
                      />
                    ))}
                  </List>
                </View>
              ))
            )}
            {state.items.length > 0 ? (
              state.loadingMore || !state.hasMore ? (
                <ListFooter status={state.loadingMore ? "loading" : "done"} />
              ) : (
                <Button
                  variant="secondary"
                  block
                  onClick={() => {
                    void controller.more();
                  }}
                >
                  继续查看消息
                </Button>
              )
            ) : null}
            <TextButton
              className="messages-page__action"
              onClick={() => {
                setSettingsOpen(true);
                void controller.settings();
              }}
            >
              订阅通知设置
            </TextButton>
            <View className="messages-page__hint">
              站内消息会保留。微信提醒以实际订阅状态为准。
            </View>
          </>
        )}
      </PageBody>
      <Sheet
        visible={settingsOpen && Boolean(token)}
        title="订阅通知"
        description="点击下方按钮选择微信提醒；拒绝后可在冷却期结束后再试。"
        onClose={() => setSettingsOpen(false)}
        footer={
          <Button
            block
            disabled={
              state.settingsLoading ||
              !state.settings?.items.some((item) => item.tmplId && item.state !== "unavailable")
            }
            onClick={subscribe}
          >
            选择订阅提醒
          </Button>
        }
      >
        {state.settingsLoading ? (
          <Skeleton rows={3} />
        ) : state.settingsError ? (
          <LoadError
            message={state.settingsError}
            onRetry={() => {
              void controller.settings();
            }}
          />
        ) : state.settings ? (
          <>
            <View className="messages-page__hint">
              每次最多 {state.settings.maxPerAsk} 类；拒绝冷却 {state.settings.cooldownDays} 天
            </View>
            <List>
              {state.settings.items.map((item) => (
                <ListRow
                  key={item.slotKey}
                  title={item.title}
                  description={item.sceneNames.join("、")}
                  value={settingLabels[item.state] ?? "状态待更新"}
                  arrow={false}
                />
              ))}
            </List>
            {state.settings.items.length === 0 ? <Empty title="暂无可订阅提醒" /> : null}
          </>
        ) : null}
      </Sheet>
    </View>
  );
}
