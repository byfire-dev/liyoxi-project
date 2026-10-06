import { useEffect, useRef, useState } from "react";
import { View } from "@tarojs/components";
import Taro, { usePullDownRefresh } from "@tarojs/taro";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { formatInteger, formatMoney } from "@liyoxi/shared/format/money";

import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { DescList } from "@/components/DescList";
import { InfoTag } from "@/components/InfoTag";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag, merchantStatusByEnum } from "@/components/StatusTag";
import { account } from "@/lib/account-runtime";
import { request } from "@/lib/runtime";
import { useBootstrapStore } from "@/stores/bootstrap";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";

import { createWalletApi } from "./api";
import { billingCopy, purchaseVisible, walletPurchaseLabel } from "./model";

import "./index.scss";

type WalletData = {
  wallet: Awaited<ReturnType<ReturnType<typeof createWalletApi>["wallet"]>>;
  policy: Awaited<ReturnType<ReturnType<typeof createWalletApi>["policy"]>>;
  plans: Awaited<ReturnType<ReturnType<typeof createWalletApi>["plans"]>> | null;
};
const api = createWalletApi(request);

export default function WalletPage() {
  const rev = useContextStore((value) => value.contextRev);
  const token = useSessionStore((value) => value.accessToken);
  return <WalletContent key={`${rev}:${token ?? "guest"}`} />;
}

function WalletContent() {
  const copy = useBootstrapStore((value) => value.data.copy);
  const [data, setData] = useState<WalletData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const own = ++generation.current;
    let stopped = false;
    void account
      .start()
      .then(async () => {
        setError(null);
        const context = useContextStore.getState();
        const session = useSessionStore.getState().accessToken;
        const current = () =>
          !stopped &&
          own === generation.current &&
          context.contextRev === useContextStore.getState().contextRev &&
          session === useSessionStore.getState().accessToken;
        const [wallet, policy] = await Promise.all([api.wallet(), api.policy()]);
        if (!current()) return;
        const plans =
          wallet.subscription.status === "expired" && purchaseVisible(policy)
            ? await api.plans()
            : null;
        if (current()) setData({ wallet, policy, plans });
      })
      .catch((failure: unknown) => {
        if (!stopped && own === generation.current)
          setError(failure instanceof Error ? failure.message : "暂时无法加载，请重试");
      })
      .finally(() => {
        void Taro.stopPullDownRefresh();
      });
    return () => {
      stopped = true;
      generation.current += 1;
    };
  }, [refresh]);
  usePullDownRefresh(() => setRefresh((value) => value + 1));
  const wallet = data?.wallet;
  const status =
    wallet && merchantStatusByEnum("billing_account.sub_status", wallet.subscription.status);
  const noun = data ? billingCopy(data.policy.copy.planNounKey, copy) : "";
  const pointsNoun = data ? billingCopy(data.policy.copy.pointsNounKey, copy) : "";
  const purchase = data ? walletPurchaseLabel(data.wallet, data.policy, copy) : null;
  return (
    <View className="billing-wallet" id={data ? "billing-ready" : undefined}>
      <PageBody>
        {error ? (
          <LoadError message={error} onRetry={() => setRefresh((value) => value + 1)} />
        ) : !wallet || !data ? (
          <Skeleton cards={3} />
        ) : (
          <>
            <Card
              variant="dark"
              eyebrow={`当前${noun}`}
              title={
                <View className="billing-wallet__plan">
                  {wallet.subscription.plan?.name ?? `暂未开通${noun}`}
                </View>
              }
              extra={status ? <StatusTag tone={status.tone}>{status.label}</StatusTag> : undefined}
            >
              <View>
                {wallet.subscription.startDate && wallet.subscription.endDate
                  ? `${wallet.subscription.startDate} 至 ${wallet.subscription.endDate}`
                  : "开通后可享短剧定制服务"}
                {wallet.subscription.remainingDays !== null
                  ? ` · 剩余 ${wallet.subscription.remainingDays} 天`
                  : ""}
              </View>
              {wallet.subscription.benefits ? (
                <View className="billing-wallet__tags">
                  <InfoTag>
                    每月 {formatInteger(wallet.subscription.benefits.monthlyPoints)} {pointsNoun}
                  </InfoTag>
                  <InfoTag>
                    门店 {wallet.usage.storesUsed} / {wallet.usage.storeLimit} 家
                  </InfoTag>
                  <InfoTag>
                    成员 {wallet.usage.seatsUsed} / {wallet.usage.memberLimit ?? "不限"} 位
                  </InfoTag>
                  {wallet.subscription.benefits.hasMonthlyReport ? (
                    <InfoTag>月度效果报告</InfoTag>
                  ) : null}
                </View>
              ) : null}
              {purchase ? (
                <Button
                  block
                  onClick={() => {
                    void Taro.navigateTo({ url: "/sub/billing/plan-pick/index" });
                  }}
                >
                  {purchase}
                </Button>
              ) : null}
            </Card>
            {wallet.subscription.isRefundPending ? (
              <Note>
                退款处理中，暂不能使用{pointsNoun}或购买{noun}
              </Note>
            ) : null}
            {wallet.points.planPointsExpireAt ? (
              <Note>
                本期剩余 {formatInteger(wallet.points.planAvailablePoints)} {noun}
                {pointsNoun}，{appDateTimeFormat.dateTime(wallet.points.planPointsExpireAt)}{" "}
                清零；订购时优先扣除。
              </Note>
            ) : null}
            {wallet.points.lastExpired ? (
              <Note>
                已于 {appDateTimeFormat.date(wallet.points.lastExpired.expiredAt)} 清零{" "}
                {formatInteger(wallet.points.lastExpired.expiredPoints)} {noun}
                {pointsNoun}
              </Note>
            ) : null}
            <Card title={`可用${pointsNoun}`}>
              <View className="billing-wallet__balance">
                {formatInteger(wallet.points.spendablePoints)}
              </View>
              <DescList
                labelWidth="lg"
                items={[
                  {
                    label: `${noun}${pointsNoun}`,
                    value: formatInteger(wallet.points.planAvailablePoints),
                  },
                  {
                    label: `加购${pointsNoun}`,
                    value: `${formatInteger(wallet.points.addonAvailablePoints)}${wallet.points.isAddonSuspended ? " · 已停用" : ""}`,
                  },
                  { label: "冻结中", value: formatInteger(wallet.points.heldPoints) },
                  {
                    label: "本期已发放",
                    value: formatInteger(wallet.points.planGrantedThisTermPoints),
                  },
                ]}
              />
            </Card>
            {wallet.subscription.scheduledTerms.map((term, index) => (
              <Card key={`${term.startDate}:${index}`} title={`下期${noun}`}>
                <DescList
                  items={[
                    { label: "版本", value: term.planName },
                    { label: "有效期", value: `${term.startDate} 至 ${term.endDate}` },
                  ]}
                />
              </Card>
            ))}
            {data.plans?.items.map((plan) => (
              <Card key={plan.planId} title={plan.name}>
                <View>
                  每月 {formatInteger(plan.monthlyPoints)} {pointsNoun}
                </View>
                {purchaseVisible(data.policy) && plan.monthlyFeeFen !== null ? (
                  <View>{formatMoney(plan.monthlyFeeFen)} / 月</View>
                ) : null}
              </Card>
            ))}
            <Card title={`${pointsNoun}怎么用`}>
              <DescList
                labelWidth="lg"
                items={[
                  { label: "订购短剧", value: "按短剧详情中的订购报价扣除" },
                  {
                    label: "广告制作",
                    value: `每条 ${formatInteger(wallet.rules.adUnitPoints)} ${pointsNoun}${wallet.rules.discountedAdUnitPoints === null ? "" : `，当前每条 ${formatInteger(wallet.rules.discountedAdUnitPoints)} ${pointsNoun}`}；每条免费修改 ${wallet.rules.adFreeRevisions} 次`,
                  },
                  {
                    label: "扣减顺序",
                    value: `先扣${noun}${pointsNoun}，不足再扣加购${pointsNoun}`,
                  },
                ]}
              />
            </Card>
          </>
        )}
      </PageBody>
    </View>
  );
}
