import { View } from "@tarojs/components";
import Taro from "@tarojs/taro";

import { Avatar } from "@/components/Avatar";
import { Card } from "@/components/Card";
import { Icon } from "@/components/Icon";
import { InfoTag } from "@/components/InfoTag";
import { LoadError } from "@/components/LoadError";
import { Sheet } from "@/components/Sheet";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag, merchantStatusByEnum } from "@/components/StatusTag";
import { TextButton } from "@/components/TextButton";
import { accountPageImplemented } from "@/lib/account-entries";
import { account, useAccount } from "@/lib/account-runtime";
import { useContextStore } from "@/stores/context";

import "./index.scss";

export function StoreSwitcher() {
  const state = useAccount();
  const current = useContextStore((value) => value.currentStoreId);
  const data = state.stores;
  return (
    <Sheet
      visible={state.switchVisible}
      title="切换门店"
      description="选择这次要管理的门店"
      onClose={() => {
        if (!state.switching) account.closeSwitcher();
      }}
      closeOnOverlayClick={!state.switching}
    >
      {data ? (
        <View className="account-switcher">
          {data.viewerRole === "owner" ? (
            <Card variant="subtle">
              <View className="account-switcher__quota-title">
                {data.entity.name ?? "商家主体"}
              </View>
              <View className="account-switcher__meta">
                已用 {data.entity.storesUsed} / {data.entity.storeLimit} 家门店 ·{" "}
                {data.entity.subscription?.planName ?? "暂未开通套餐"}
              </View>
            </Card>
          ) : null}
          {data.items.map((item) => {
            const status = merchantStatusByEnum(
              "store.qualification_status",
              item.qualificationStatus,
            );
            const selected = item.storeId === current;
            return (
              <View
                key={item.storeId}
                className={`account-switcher__item${selected ? " account-switcher__item--selected" : ""}`}
                onClick={() => {
                  if (!state.switching)
                    void account.switchStore(item.storeId, item.name ?? "未命名门店", "mine");
                }}
              >
                <Avatar text={item.name ?? "店"} size={44} />
                <View className="account-switcher__main">
                  <View className="account-switcher__name">
                    {item.name ?? "未命名门店"} {item.isPrimary ? <InfoTag>主店</InfoTag> : null}
                  </View>
                  <View className="account-switcher__meta">
                    {item.city?.name ?? "城市待完善"} · {item.category?.name ?? "行业待完善"}
                  </View>
                  {item.lifecycle === "archived" ? <InfoTag>已停用</InfoTag> : null}
                  {status ? (
                    <StatusTag tone={status.tone} plain>
                      {status.label}
                    </StatusTag>
                  ) : (
                    <InfoTag>状态待确认</InfoTag>
                  )}
                </View>
                {selected ? <Icon name="check-circle" /> : null}
              </View>
            );
          })}
          {data.items.length === 0 ? (
            <View className="account-switcher__meta">暂无可切换的门店</View>
          ) : null}
          {data.viewerRole === "owner" &&
          data.entity.canAddStore &&
          accountPageImplemented("sub/profile/store-add/index") ? (
            <TextButton
              arrow
              onClick={() => {
                void Taro.navigateTo({ url: "/sub/profile/store-add/index" });
              }}
            >
              新增门店
            </TextButton>
          ) : null}
          {state.switching ? <View className="account-switcher__meta">正在切换门店…</View> : null}
        </View>
      ) : state.error ? (
        <LoadError
          message={state.error}
          onRetry={() => {
            void account.openSwitcher();
          }}
        />
      ) : (
        <Skeleton cards={2} />
      )}
    </Sheet>
  );
}
