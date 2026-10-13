import { useState } from "react";
import { View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";

import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Empty } from "@/components/Empty";
import { InfoTag } from "@/components/InfoTag";
import { List, ListRow } from "@/components/List";
import { LoadError } from "@/components/LoadError";
import { Sheet } from "@/components/Sheet";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag, merchantStatusByEnum } from "@/components/StatusTag";
import { StoreSwitcher } from "@/components/StoreSwitcher";
import { TextButton } from "@/components/TextButton";
import { accountEntries, accountPageImplemented } from "@/lib/account-entries";
import { accountError } from "@/lib/account-controller";
import { gotoAccountLogin } from "@/lib/account-routing";
import { account, useAccount } from "@/lib/account-runtime";
import { useSessionStore } from "@/stores/session";
import { useMessageBadge } from "@/stores/messages";

import "./index.scss";

export default function Mine() {
  const unread = useMessageBadge();
  const state = useAccount();
  const token = useSessionStore((value) => value.accessToken);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    void account
      .start()
      .then(() => account.loadMine())
      .catch((failure) => setError(accountError(failure)));
  };
  useDidShow(load);
  const data = state.overview;
  const store = data?.currentStore;
  const status =
    store && merchantStatusByEnum("store.qualification_status", store.qualificationStatus);
  const navigate = (route: string) => {
    void Taro.navigateTo({ url: `/${route}` });
  };
  return (
    <View
      className="account-mine"
      id={!state.booting && (!token || state.me) ? "account-ready" : undefined}
    >
      {state.booting ? (
        <Skeleton cards={3} />
      ) : !token ? (
        <Card>
          <Empty
            title="登录后，管理你的门店"
            description="查看账号、门店与短剧服务"
            actionText="去登录"
            onAction={gotoAccountLogin}
          />
        </Card>
      ) : error || state.error ? (
        <LoadError message={error ?? state.error ?? "加载失败"} onRetry={load} />
      ) : state.me ? (
        <>
          <View className="account-mine__header">
            <Avatar text={store?.name ?? state.me.user.displayName ?? "商"} size={56} />
            <View className="account-mine__identity">
              <View className="account-mine__name">
                {store?.name ?? state.me.user.displayName ?? "商家账号"}
              </View>
              <View className="account-mine__phone">{state.me.user.phoneMask}</View>
              <View className="account-mine__tags">
                {data ? <InfoTag>{data.viewerRole === "owner" ? "老板" : "店员"}</InfoTag> : null}
                {store?.lifecycle === "archived" ? <InfoTag>已停用</InfoTag> : null}
                {status ? <StatusTag tone={status.tone}>{status.label}</StatusTag> : null}
              </View>
            </View>
            {state.me.memberships.some((item) => item.stores.length > 0) ? (
              <TextButton
                onClick={() => {
                  void account.openSwitcher();
                }}
              >
                切换门店
              </TextButton>
            ) : null}
          </View>
          {data?.viewerRole === "owner" ? (
            <>
              <Card
                variant="dark"
                eyebrow="套餐与积分"
                title={data.subscription.planName ?? "暂未开通套餐"}
                extra={
                  accountPageImplemented("sub/billing/wallet/index") ? (
                    <TextButton arrow onClick={() => navigate("sub/billing/wallet/index")}>
                      查看钱包
                    </TextButton>
                  ) : undefined
                }
              >
                <View className="account-mine__points">
                  {data.subscription.spendablePoints}
                  <View>可用积分</View>
                </View>
                <View className="account-mine__plan-meta">
                  {data.subscription.endDate
                    ? `有效期至 ${data.subscription.endDate}`
                    : "开通套餐后可享短剧定制服务"}
                  {data.subscription.remainingDays !== null
                    ? ` · 剩余 ${data.subscription.remainingDays} 天`
                    : ""}
                </View>
              </Card>
              <View className="account-mine__stats">
                <View>
                  <View>{data.storeStats.liveCount}</View>已上线
                </View>
                <View>
                  <View>{data.storeStats.deliveringCount}</View>交付中
                </View>
                <View>
                  <View>{data.storeStats.cartCount}</View>选剧单
                </View>
              </View>
            </>
          ) : null}
          {!state.me.memberships.some((item) => item.stores.length > 0) ? (
            <Card>
              <Empty
                title="尚未绑定门店"
                description="门店档案建立后，可在这里管理门店"
                actionText={
                  accountPageImplemented("sub/profile/profile/index") ? "开始建档" : undefined
                }
                onAction={() => navigate("sub/profile/profile/index")}
              />
            </Card>
          ) : null}
          {data && accountEntries(data.viewerRole).length ? (
            <List>
              <ListRow title="门店管理" onClick={() => navigate("sub/profile/stores/index")} />
              {data.viewerRole === "clerk" ? (
                <ListRow title="门店成员" onClick={() => navigate("sub/member/members/index")} />
              ) : null}
              {accountEntries(data.viewerRole)
                .filter(
                  (item) =>
                    item.route !== "sub/profile/staff-profile/index" || data.viewerRole === "clerk",
                )
                .map((item) => (
                  <ListRow
                    key={item.route}
                    title={item.title}
                    badge={
                      item.route === "sub/service/messages/index"
                        ? (unread ?? undefined)
                        : undefined
                    }
                    onClick={() => navigate(item.route)}
                  />
                ))}
            </List>
          ) : null}
          {!data ? (
            <List>
              <ListRow
                title="消息"
                badge={unread ?? undefined}
                onClick={() => navigate("sub/service/messages/index")}
              />
              <ListRow title="设置" onClick={() => navigate("sub/service/settings/index")} />
            </List>
          ) : null}
        </>
      ) : (
        <Skeleton cards={2} />
      )}
      {!token ? (
        <List>
          <ListRow title="设置" onClick={() => navigate("sub/service/settings/index")} />
        </List>
      ) : null}
      <StoreSwitcher />
      <Sheet
        visible={Boolean(token && state.switchedFrom)}
        title="已切换登录账号"
        description={`刚才登录的是 ${state.switchedFrom ?? ""}，现在显示本次登录的账号`}
        onClose={account.dismissSwitchNotice}
        footer={
          <Button block onClick={account.dismissSwitchNotice}>
            知道了
          </Button>
        }
      />
    </View>
  );
}
