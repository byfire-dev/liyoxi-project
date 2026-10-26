import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, usePullDownRefresh } from "@tarojs/taro";
import { formatInteger, formatMoney } from "@liyoxi/shared/format/money";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { DescList } from "@/components/DescList";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag, merchantStatusByEnum } from "@/components/StatusTag";
import { account, useAccount } from "@/lib/account-runtime";
import type { Data } from "@/lib/account-api";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { createPurchaseApi } from "../../billing/plan-pick/api";
import { paymentView, type Payment } from "../../billing/plan-pick/model";
import { ReceiptPicker } from "../../billing/plan-pick/receipt";
import { billingRequest } from "../../billing/wallet/runtime";
import { purchaseVisible } from "../../billing/wallet/model";
import { currentPurchaseContext, paymentIntent } from "../../billing/topup/runtime";
import "./index.scss";
const api = createPurchaseApi(billingRequest);
export function PaymentResult({ id }: { id: string }) {
  useAccount();
  const rev = useContextStore((v) => v.contextRev),
    token = useSessionStore((v) => v.accessToken);
  return (
    <PaymentContent
      key={`${id}:${rev}:${token ?? "guest"}:${currentPurchaseContext("plan.purchase").key}`}
      id={id}
    />
  );
}
function PaymentContent({ id }: { id: string }) {
  const [order, setOrder] = useState<Payment | null>(null),
    [error, setError] = useState<string | null>(null),
    [refresh, setRefresh] = useState(0);
  const generation = useRef(0),
    active = useRef(true);
  const scope = currentPurchaseContext("plan.purchase").key;
  const current = useCallback(
    () =>
      active.current &&
      scope === currentPurchaseContext("plan.purchase").key &&
      currentPurchaseContext("plan.purchase").allowed,
    [scope],
  );
  const pay = useMemo(
    () =>
      paymentIntent(
        () =>
          scope === currentPurchaseContext("plan.purchase").key &&
          currentPurchaseContext("plan.purchase").allowed,
      ),
    [scope],
  );
  const [policy, setPolicy] = useState<Data<"m.purchasePolicy.get"> | null>(null);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<string | null>(null);
  useDidHide(() => {
    active.current = false;
    generation.current++;
    pay.invalidate();
    setBusy(false);
  });
  useDidShow(() => {
    if (!active.current) {
      active.current = true;
      setRefresh((v) => v + 1);
    }
  });
  useEffect(() => {
    const own = ++generation.current,
      rev = useContextStore.getState().contextRev,
      token = useSessionStore.getState().accessToken;
    const valid = () =>
      active.current &&
      current() &&
      own === generation.current &&
      rev === useContextStore.getState().contextRev &&
      token === useSessionStore.getState().accessToken;
    void account
      .start()
      .then(() => {
        if (!valid()) return null;
        return Promise.all([api.detail(id), api.policy()]);
      })
      .then((v) => {
        if (v && valid()) {
          setOrder(v[0]);
          setPolicy(v[1]);
          setError(null);
        }
      })
      .catch((e) => {
        if (valid()) setError(e instanceof Error ? e.message : "暂未取得付款结果");
      })
      .finally(() => {
        if (valid()) void Taro.stopPullDownRefresh();
      });
    return () => {
      generation.current = own + 1;
      pay.invalidate();
    };
  }, [id, refresh, current, pay]);
  useEffect(
    () => () => {
      active.current = false;
      pay.invalidate();
    },
    [pay],
  );
  usePullDownRefresh(() => {
    if (!pay.pending) setRefresh((v) => v + 1);
  });
  async function action(kind: "pay" | "sync" | "cancel") {
    if (pay.pending || !current()) return;
    const own = generation.current;
    const valid = () => current() && own === generation.current;
    setBusy(true);
    setNotice(null);
    try {
      const result = await pay[kind](id);
      if (result && valid()) {
        setOrder(result.order);
        setNotice(result.notice);
      }
    } catch {
      if (valid()) setNotice("暂未确认付款结果，付款单已保留，请稍后查询");
    } finally {
      if (valid()) setBusy(false);
    }
  }
  if (!currentPurchaseContext("plan.purchase").allowed)
    return (
      <PageBody>
        <Note>当前身份无法查看付款单，请使用有权限的老板账号。</Note>
      </PageBody>
    );
  if (error)
    return (
      <PageBody>
        <LoadError message={error} onRetry={() => setRefresh((v) => v + 1)} />
      </PageBody>
    );
  if (!order)
    return (
      <PageBody>
        <Skeleton />
      </PageBody>
    );
  const view = paymentView(order),
    tone = merchantStatusByEnum(
      order.transferState === "proof_rejected"
        ? "payment_order.transfer_state"
        : "payment_order.status",
      order.transferState === "proof_rejected" ? order.transferState : order.status,
    );
  return (
    <View className="billing-result" id="billing-ready">
      <PageBody>
        <Card>
          <View className="billing-result__title">{view.title}</View>
          <Note>{view.description}</Note>
          {tone ? <StatusTag tone={tone.tone}>{tone.label}</StatusTag> : null}
        </Card>
        <Card title="付款单">
          <DescList
            items={[
              { label: "付款单号", value: order.orderNo },
              { label: "内容", value: order.title },
              { label: "应付金额", value: formatMoney(order.amountFen) },
              {
                label: "支付渠道",
                value: order.channel === "bank_transfer" ? "对公转账" : "微信支付",
              },
            ]}
          />
        </Card>
        {order.fulfillment ? (
          <Card title="履约结果">
            <DescList
              items={[
                {
                  label: "有效期",
                  value: order.fulfillment.term
                    ? `${order.fulfillment.term.startDate} 至 ${order.fulfillment.term.endDate}`
                    : "—",
                },
                {
                  label: "到账积分",
                  value:
                    order.fulfillment.points === null
                      ? "—"
                      : formatInteger(order.fulfillment.points),
                },
              ]}
            />
          </Card>
        ) : null}
        {order.transferState === "proof_rejected" ? (
          <Card title="驳回原因">
            <Note>
              {order.latestTransferProof?.rejectReason?.name ?? "请核对凭证"}：
              {order.latestTransferProof?.rejectNote ?? "—"}
            </Note>
          </Card>
        ) : null}
        {view.canUpload ? (
          <Card title={order.transferState === "proof_rejected" ? "重新提交凭证" : "提交转账凭证"}>
            <DescList
              items={[
                { label: "收款户名", value: order.bankAccount?.accountName ?? "—" },
                {
                  label: "银行账号",
                  value: order.bankAccount?.accountNo ?? order.bankAccount?.accountNoMask ?? "—",
                },
                { label: "转账备注", value: order.bankAccount?.transferRemark ?? order.orderNo },
              ]}
            />
            <ReceiptPicker
              payment={order}
              api={api}
              onSubmitted={(value) => {
                if (current()) setOrder(value);
              }}
            />
          </Card>
        ) : null}
        {notice ? <Note>{notice}</Note> : null}
        {order.actions.includes("wechat-prepay") &&
        policy &&
        purchaseVisible(policy) &&
        policy.channels.some((channel) => channel.code === "wechat_jsapi" && channel.isEnabled) ? (
          <Button
            block
            loading={busy}
            onClick={() => {
              void action("pay");
            }}
          >
            继续微信支付
          </Button>
        ) : null}
        {order.actions.includes("sync") ? (
          <Button
            block
            variant="outline"
            disabled={busy}
            onClick={() => {
              void action("sync");
            }}
          >
            查询付款结果
          </Button>
        ) : null}
        {order.actions.includes("cancel") ? (
          <Button
            block
            variant="outline"
            disabled={busy}
            onClick={() => {
              void action("cancel");
            }}
          >
            取消付款单
          </Button>
        ) : null}
        <Button
          variant="outline"
          block
          onClick={() => void Taro.navigateTo({ url: "/sub/billing/wallet/index" })}
        >
          查看钱包
        </Button>
        <Note>下拉刷新可查看最新结果</Note>
      </PageBody>
    </View>
  );
}
