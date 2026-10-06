import { useEffect, useRef, useState } from "react";
import { View } from "@tarojs/components";
import Taro, { usePullDownRefresh } from "@tarojs/taro";
import { formatInteger, formatMoney } from "@liyoxi/shared/format/money";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { DescList } from "@/components/DescList";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag, merchantStatusByEnum } from "@/components/StatusTag";
import { account } from "@/lib/account-runtime";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { createPurchaseApi } from "../../billing/plan-pick/api";
import { paymentView, type Payment } from "../../billing/plan-pick/model";
import { ReceiptPicker } from "../../billing/plan-pick/receipt";
import { billingRequest } from "../../billing/wallet/runtime";
import "./index.scss";
const api = createPurchaseApi(billingRequest);
export function PaymentResult({ id }: { id: string }) {
  const rev = useContextStore((v) => v.contextRev),
    token = useSessionStore((v) => v.accessToken);
  return <PaymentContent key={`${id}:${rev}:${token ?? "guest"}`} id={id} />;
}
function PaymentContent({ id }: { id: string }) {
  const [order, setOrder] = useState<Payment | null>(null),
    [error, setError] = useState<string | null>(null),
    [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const own = ++generation.current,
      rev = useContextStore.getState().contextRev,
      token = useSessionStore.getState().accessToken;
    const current = () =>
      own === generation.current &&
      rev === useContextStore.getState().contextRev &&
      token === useSessionStore.getState().accessToken;
    void account
      .start()
      .then(() => api.detail(id))
      .then((v) => {
        if (current()) {
          setOrder(v);
          setError(null);
        }
      })
      .catch((e) => {
        if (current()) setError(e instanceof Error ? e.message : "暂未取得付款结果");
      })
      .finally(() => {
        if (current()) void Taro.stopPullDownRefresh();
      });
    return () => {
      generation.current = own + 1;
    };
  }, [id, refresh]);
  usePullDownRefresh(() => setRefresh((v) => v + 1));
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
          <Card title="开通结果">
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
            <ReceiptPicker payment={order} api={api} onSubmitted={setOrder} />
          </Card>
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
