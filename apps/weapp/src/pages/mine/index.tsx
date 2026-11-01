import { useState } from "react";
import { Text, View } from "@tarojs/components";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { formatInteger } from "@liyoxi/shared/format/money";
import Taro, { useDidShow } from "@tarojs/taro";

import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Empty } from "@/components/Empty";
import { Icon } from "@/components/Icon";
import { IconTile } from "@/components/IconTile";
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
  const owner = data?.viewerRole === "owner" ? data : null;
  const hasStores = state.me?.memberships.some((item) => item.stores.length > 0);
  const location = [store?.city?.name, store?.category?.name].filter(Boolean).join(" · ");
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
          <Card className="account-mine__store-card">
            <View className="account-mine__header">
              <Avatar
                text={store?.name ?? state.me.user.displayName ?? "商"}
                size={56}
                tone="solid"
              />
              <View className="account-mine__identity">
                <View className="account-mine__heading">
                  {" "}
                  <View className="account-mine__name">
                    {store?.name ?? state.me.user.displayName ?? "商家账号"}
                  </View>{" "}
                  {hasStores ? (
                    <TextButton
                      tone="muted"
                      className="account-mine__switch"
                      onClick={() => {
                        void account.openSwitcher();
                      }}
                    >
                      切换门店
                    </TextButton>
                  ) : null}
                </View>
                {!store ? (
                  <View className="account-mine__phone">{state.me.user.phoneMask}</View>
                ) : null}
                <View className="account-mine__tags">
                  {status ? <StatusTag tone={status.tone}>{status.label}</StatusTag> : null}
                  {location ? <InfoTag>{location}</InfoTag> : null}
                  {data ? <InfoTag>{data.viewerRole === "owner" ? "老板" : "店员"}</InfoTag> : null}
                  {store?.lifecycle === "archived" ? <InfoTag>已停用</InfoTag> : null}
                </View>
              </View>
            </View>
            {store ? (
              <View
                className="account-mine__profile"
                onClick={
                  owner && accountPageImplemented("sub/profile/profile/index")
                    ? () => navigate("sub/profile/profile/index")
                    : undefined
                }
              >
                <Text className="account-mine__profile-title">
                  {owner ? "商家档案" : "门店信息"}
                </Text>
                <Text className="account-mine__profile-summary">
                  门店素材 {formatInteger(store.assetCount)} 条 · 店员{" "}
                  {formatInteger(store.clerkCount)} 位
                </Text>
                {owner && accountPageImplemented("sub/profile/profile/index") ? (
                  <Icon name="chevron-right" size={16} />
                ) : null}
              </View>
            ) : null}
          </Card>
          {owner ? (
            <Card className="account-mine__membership">
              <View className="account-mine__plan-header">
                <View className="account-mine__plan-badge">
                  <Icon name="crown" size={14} />
                  <Text>{owner.subscription.planName ?? "未开通套餐"}</Text>
                </View>
                <View className="account-mine__plan-meta">
                  {owner.subscription.status === "expired"
                    ? "套餐已到期"
                    : owner.subscription.endDate
                      ? `有效期至 ${owner.subscription.endDate}`
                      : "尚未开通套餐"}
                  {owner.subscription.status === "active" &&
                  owner.subscription.remainingDays !== null
                    ? ` · 剩 ${owner.subscription.remainingDays} 天`
                    : ""}
                </View>
                {accountPageImplemented("sub/billing/wallet/index") ? (
                  <TextButton
                    tone="muted"
                    arrow
                    onClick={() => navigate("sub/billing/wallet/index")}
                  >
                    套餐与积分
                  </TextButton>
                ) : null}
              </View>
              <View className="account-mine__balance">
                <View className="account-mine__balance-main">
                  <View className="account-mine__balance-label">可用积分 · 名下门店共用</View>
                  <View className="account-mine__points">
                    {formatInteger(owner.subscription.spendablePoints)}
                  </View>
                </View>
                <View className="account-mine__breakdown">
                  <View>套餐积分 {formatInteger(owner.subscription.planAvailablePoints)}</View>
                  <View>加购积分 {formatInteger(owner.subscription.addonAvailablePoints)}</View>
                </View>
              </View>
              {owner.subscription.status === "active" && owner.subscription.planPointsExpireAt ? (
                <View className="account-mine__expiry">
                  本期剩余 {formatInteger(owner.subscription.planAvailablePoints)} 套餐积分，
                  {appDateTimeFormat.deadline(owner.subscription.planPointsExpireAt)} 清零
                </View>
              ) : null}
              {owner.subscription.isAddonSuspended ? (
                <View className="account-mine__expiry">
                  加购积分当前暂停使用，请查看套餐与积分。
                </View>
              ) : null}
              {owner.subscription.isRefundPending ? (
                <View className="account-mine__expiry">套餐退款处理中，详情请查看套餐与积分。</View>
              ) : null}
            </Card>
          ) : null}
          {data && accountPageImplemented("sub/profile/stores/index") ? (
            <Card
              className="account-mine__stores"
              onClick={() => navigate("sub/profile/stores/index")}
            >
              <IconTile icon="store" size={40} />
              <View className="account-mine__store-summary">
                <View className="account-mine__section-title">
                  我的门店 · {formatInteger(data.stores.visibleCount)} 家
                </View>
                <View className="account-mine__store-note">
                  {owner
                    ? `${owner.subscription.planName ?? "当前套餐"}可管理 ${owner.stores.storeLimit} 家${owner.stores.reviewingStores.length ? ` · ${owner.stores.reviewingStores.map((item) => item.name ?? "未命名门店").join("、")}审核中` : ""}`
                    : "查看你所属的门店"}
                </View>
              </View>
              <Icon name="chevron-right" size={16} />
            </Card>
          ) : null}
          {owner ? (
            <View className="account-mine__stats">
              <View>
                <View>{formatInteger(owner.storeStats.liveCount)}</View>上线中
              </View>
              <View>
                <View>{formatInteger(owner.storeStats.deliveringCount)}</View>交付中
              </View>
              <View>
                <View>{formatInteger(owner.storeStats.cartCount)}</View>选剧单
              </View>
            </View>
          ) : null}
          {store ? (
            <View className="account-mine__service">
              <View className="account-mine__service-icon">
                <Icon name="headset" size={22} />
              </View>
              <View>
                <View className="account-mine__section-title">门店服务支持</View>
                <View className="account-mine__service-note">有服务问题，请联系你的服务经理</View>
              </View>
            </View>
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
              {owner && accountPageImplemented("sub/order/orders/index") ? (
                <ListRow
                  icon="file-text"
                  title="我的订单"
                  onClick={() => navigate("sub/order/orders/index")}
                />
              ) : null}
              {owner && accountPageImplemented("sub/order/my-dramas/index") ? (
                <ListRow
                  icon="drama"
                  title="我的短剧"
                  value={`${owner.storeStats.liveCount} 部上线中`}
                  onClick={() => navigate("sub/order/my-dramas/index")}
                />
              ) : null}
              {data.viewerRole === "owner" && accountPageImplemented("sub/ad/ads/index") ? (
                <ListRow
                  icon="video"
                  title="我的广告"
                  badge={data.entries.adPendingConfirmCount || undefined}
                  description={`待确认${data.entries.adPendingConfirmCount}条`}
                  onClick={() => navigate("sub/ad/ads/index")}
                />
              ) : null}
              {data.viewerRole === "clerk" ? (
                <ListRow title="门店成员" onClick={() => navigate("sub/member/members/index")} />
              ) : null}
              {accountEntries(data.viewerRole)
                .filter(
                  (item) =>
                    item.route !== "sub/profile/profile/index" &&
                    item.route !== "sub/order/orders/index" &&
                    (item.route !== "sub/profile/staff-profile/index" ||
                      data.viewerRole === "clerk"),
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
