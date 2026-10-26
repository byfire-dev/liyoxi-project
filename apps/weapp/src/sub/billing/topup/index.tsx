import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, usePullDownRefresh } from "@tarojs/taro";
import { formatInteger, formatMoney } from "@liyoxi/shared/format/money";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Empty } from "@/components/Empty";
import { FooterBar } from "@/components/FooterBar";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { OptionCard } from "@/components/OptionCard";
import { PageBody } from "@/components/PageBody";
import { Sheet } from "@/components/Sheet";
import { Skeleton } from "@/components/Skeleton";
import { TextButton } from "@/components/TextButton";
import { useAccount } from "@/lib/account-runtime";
import { ApiError } from "@/lib/request";
import { newIdempotencyKey } from "@/lib/runtime";
import { useBootstrapStore } from "@/stores/bootstrap";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { messageScope } from "@/stores/messages-scope";
import { billingCopy } from "../wallet/model";
import {
  createPurchaseIntent,
  enabledChannels,
  existingOrder,
  purchaseAgreements,
} from "../plan-pick/model";
import { topupBlock, topupBody, topupConfirmationKey } from "./model";
import { paymentIntent, topupApi, topupModel } from "./runtime";
import "./index.scss";

const resultPage = (id: string) =>
  Taro.navigateTo({
    url: `/sub/order/result/index?type=payment&paymentOrderId=${encodeURIComponent(id)}`,
  });
export default function TopupPage() {
  const me = useAccount().me;
  const token = useSessionStore((s) => s.accessToken);
  const { currentStoreId: storeId, contextRev } = useContextStore();
  return <TopupContent key={messageScope({ me, token, storeId, contextRev })} />;
}
function TopupContent() {
  const model = useMemo(() => topupModel(), []);
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const pay = useMemo(() => paymentIntent(model.isCurrent), [model]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const intent = useRef<ReturnType<typeof createPurchaseIntent> | null>(null);
  const locked = useRef<object | null>(null),
    revision = useRef(0);
  const copy = useBootstrapStore((s) => s.data.copy);
  function invalidate() {
    revision.current++;
    intent.current = null;
    setConfirming(null);
  }
  useEffect(() => {
    const own = ++revision.current;
    void model.show();
    return () => {
      revision.current = own + 1;
      pay.invalidate();
      model.hide();
    };
  }, [model, pay]);
  useDidShow(() => {
    void model.show();
  });
  useDidHide(() => {
    invalidate();
    pay.invalidate();
    locked.current = null;
    setBusy(false);
    model.hide();
  });
  usePullDownRefresh(() => {
    if (locked.current) return;
    invalidate();
    void model.refresh().finally(() => {
      if (model.isCurrent()) void Taro.stopPullDownRefresh();
    });
  });
  function open(channel: string) {
    if (locked.current || !model.isCurrent()) return;
    const body = topupBody(model.snapshot(), channel);
    if (!body) return;
    const own = ++revision.current;
    intent.current = createPurchaseIntent(
      topupApi,
      body,
      newIdempotencyKey("points-topup"),
      () => own === revision.current && model.isCurrent(),
    );
    setConfirming(channel);
    setNotice(null);
  }
  async function confirm() {
    if (locked.current || !intent.current || !confirming || !model.isCurrent()) return;
    const lock = {};
    locked.current = lock;
    setBusy(true);
    setNotice(null);
    const own = revision.current,
      chosen = model.snapshot(),
      channel = confirming;
    const current = () => own === revision.current && model.isCurrent();
    const original = topupConfirmationKey(chosen, channel),
      ownIntent = intent.current;
    let created: string | null = null;
    try {
      const [wallet, policy, packs, agreements] = await Promise.all([
        topupApi.wallet(),
        topupApi.policy(),
        topupApi.packs(),
        topupApi.agreements(),
      ]);
      if (!current()) return;
      const fresh = topupConfirmationKey(
        { wallet, policy, packs: packs.items, agreements, selected: chosen.selected },
        channel,
      );
      if (!fresh || fresh !== original) {
        invalidate();
        setNotice("积分包、购买策略或协议已更新，请重新核对后确认");
        await model.refresh();
        return;
      }
      const order = await ownIntent.submit();
      if (!order || !current()) return;
      created = order.paymentOrderId;
      setExisting(created);
      if (order.channel === "wechat_jsapi") await pay.pay(created);
      if (current()) {
        invalidate();
        void resultPage(created);
      }
    } catch (failure) {
      if (!current()) return;
      const id = created ?? existingOrder(failure);
      if (id) {
        setExisting(id);
        invalidate();
        setNotice("付款单已保留，请查看真实付款结果后继续处理");
      } else if (
        failure instanceof ApiError &&
        ["QUOTE_CHANGED", "AGREEMENT_VERSION_STALE"].includes(failure.error)
      ) {
        invalidate();
        setNotice("积分包或协议已更新，请重新核对后确认");
        await model.refresh();
      } else {
        setNotice("暂未确认建单结果，可重试本次确认；请求沿用同一建单键");
      }
    } finally {
      if (locked.current === lock) {
        locked.current = null;
        if (model.isCurrent()) setBusy(false);
      }
    }
  }
  const block = topupBlock(state);
  const noun = state.policy ? billingCopy(state.policy.copy.pointsNounKey, copy) : "";
  const docs = state.policy ? purchaseAgreements(state.policy, state.agreements) : [];
  return (
    <View className="billing-topup" id={!state.loading ? "topup-ready" : undefined}>
      <PageBody>
        {state.restricted ? (
          <Empty title="当前身份无法加购积分" description="请使用有权限的老板账号。" />
        ) : state.loading ? (
          <Skeleton cards={3} />
        ) : state.error ? (
          <LoadError
            message={state.error}
            onRetry={() => {
              invalidate();
              void model.refresh();
            }}
          />
        ) : block ? (
          <Empty title={block} />
        ) : (
          <>
            <Card title={`选择${noun}包`}>
              <View className="billing-topup__packs">
                {state.packs.map((pack) => (
                  <OptionCard
                    key={pack.pointPackId}
                    title={`${formatInteger(pack.points)} ${noun}`}
                    selected={pack.pointPackId === state.selected}
                    extra={pack.priceFen === null ? "暂未开放购买" : formatMoney(pack.priceFen)}
                    onClick={() => {
                      if (!locked.current) {
                        invalidate();
                        model.select(pack.pointPackId);
                      }
                    }}
                  />
                ))}
              </View>
              {!state.packs.length ? <Empty title="暂无可购买的积分包" /> : null}
            </Card>
            <Note>付款与到账结果以付款单为准，可在积分流水查看实际入账记录。</Note>
            <View>
              确认付款即同意{" "}
              {docs.map((doc) => (
                <TextButton
                  key={doc.agreementKey}
                  onClick={() =>
                    void Taro.navigateTo({
                      url: `/pages/agreement/index?agreementVersionId=${encodeURIComponent(doc.currentVersion.agreementVersionId)}`,
                    })
                  }
                >
                  《{doc.name}》
                </TextButton>
              ))}
            </View>
            {state.policy &&
            (docs.length === 0 || docs.length !== state.policy.copy.agreementKeys.length) ? (
              <Note>购买协议暂未加载完整，请刷新后重新确认</Note>
            ) : null}
            {state.policy ? (
              enabledChannels(state.policy).length === 0 ? (
                <Note>付款方式暂未配置，请联系服务经理</Note>
              ) : (
                <FooterBar>
                  {enabledChannels(state.policy).map((channel) => (
                    <Button
                      key={channel.code}
                      disabled={busy || topupBody(state, channel.code) === null}
                      onClick={() => open(channel.code)}
                    >
                      {channel.code === "bank_transfer"
                        ? "对公转账"
                        : channel.code === "wechat_jsapi"
                          ? "微信支付"
                          : "暂未开放"}{" "}
                      {billingCopy(state.policy!.copy.payButtonKey, copy)}
                    </Button>
                  ))}
                </FooterBar>
              )
            ) : null}
          </>
        )}
        {notice ? <Note>{notice}</Note> : null}
        {existing ? (
          <Button
            variant="outline"
            onClick={() => {
              if (model.isCurrent()) void resultPage(existing);
            }}
          >
            查看付款单
          </Button>
        ) : null}
      </PageBody>
      <Sheet
        visible={confirming !== null}
        title="确认加购积分"
        description="请核对积分包、金额和购买协议"
        closeOnOverlayClick={!busy}
        onClose={() => {
          if (!locked.current) invalidate();
        }}
        footer={
          <Button
            block
            loading={busy}
            onClick={() => {
              void confirm();
            }}
          >
            确认付款
          </Button>
        }
      >
        {state.packs
          .filter((p) => p.pointPackId === state.selected)
          .map((pack) => (
            <View key={pack.pointPackId}>
              {formatInteger(pack.points)} {noun} ·{" "}
              {pack.priceFen === null ? "—" : formatMoney(pack.priceFen)}
            </View>
          ))}
        <Note>确认即同意 {docs.map((d) => `《${d.name}》`).join("、")}</Note>
        {notice ? <Note>{notice}</Note> : null}
      </Sheet>
    </View>
  );
}
