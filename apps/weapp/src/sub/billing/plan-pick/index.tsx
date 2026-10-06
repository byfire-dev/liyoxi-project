import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { formatInteger, formatMoney, formatSignedPercent } from "@liyoxi/shared/format/money";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { DescList } from "@/components/DescList";
import { Empty } from "@/components/Empty";
import { FooterBar } from "@/components/FooterBar";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { OptionCard } from "@/components/OptionCard";
import { PageBody } from "@/components/PageBody";
import { Sheet } from "@/components/Sheet";
import { Skeleton } from "@/components/Skeleton";
import { TextButton } from "@/components/TextButton";
import { account } from "@/lib/account-runtime";
import type { Agreement, Body, Data } from "@/lib/account-api";
import { newIdempotencyKey } from "@/lib/runtime";
import { useBootstrapStore } from "@/stores/bootstrap";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { billingRequest } from "../wallet/runtime";
import { billingCopy, purchaseVisible } from "../wallet/model";
import { createPurchaseApi } from "./api";
import {
  changedQuote,
  createPurchaseIntent,
  enabledChannels,
  existingOrder,
  purchaseAgreements,
  planBenefitLabels,
  type Payment,
  type Quote,
} from "./model";
import { ReceiptPicker } from "./receipt";
import "./index.scss";
const api = createPurchaseApi(billingRequest);
export const paymentResult = (id: string) =>
  Taro.redirectTo({
    url: `/sub/order/result/index?type=payment&paymentOrderId=${encodeURIComponent(id)}`,
  });
export default function PlanPickPage() {
  const rev = useContextStore((v) => v.contextRev),
    token = useSessionStore((v) => v.accessToken);
  return <PlanContent key={`${rev}:${token ?? "guest"}`} />;
}
function PlanContent() {
  const copy = useBootstrapStore((v) => v.data.copy);
  const [catalog, setCatalog] = useState<Data<"m.plan.list"> | null>(null),
    [policy, setPolicy] = useState<Data<"m.purchasePolicy.get"> | null>(null);
  const [agreements, setAgreements] = useState<Agreement[]>([]),
    [selection, setSelection] = useState<{ planId: string; months: number } | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null),
    [error, setError] = useState<string | null>(null),
    [refresh, setRefresh] = useState(0);
  const [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false),
    [payment, setPayment] = useState<Payment | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const generation = useRef(0),
    quoteGeneration = useRef(0),
    stopped = useRef(false),
    intent = useRef<ReturnType<typeof createPurchaseIntent> | null>(null);
  const rev = useContextStore.getState().contextRev,
    token = useSessionStore.getState().accessToken;
  const current = useCallback(
    () =>
      !stopped.current &&
      rev === useContextStore.getState().contextRev &&
      token === useSessionStore.getState().accessToken,
    [rev, token],
  );
  useEffect(() => {
    const own = ++generation.current;
    stopped.current = false;
    void account
      .start()
      .then(async () => {
        const [p, plans, docs] = await Promise.all([api.policy(), api.plans(), api.agreements()]);
        if (!current() || own !== generation.current) return;
        setPolicy(p);
        setCatalog(plans);
        setAgreements(docs);
        setError(null);
        const first = plans.items.find((v) => v.cyclePrices.length > 0);
        if (first) setSelection({ planId: first.planId, months: first.cyclePrices[0]!.months });
      })
      .catch((e) => {
        if (current() && own === generation.current)
          setError(e instanceof Error ? e.message : "暂时无法加载套餐");
      });
    return () => {
      stopped.current = true;
      generation.current = own + 1;
    };
  }, [refresh, current]);
  useEffect(() => {
    const own = ++quoteGeneration.current;
    intent.current = null;
    if (!selection || !policy || !purchaseVisible(policy)) return;
    void api
      .quote(selection)
      .then((v) => {
        if (current() && own === quoteGeneration.current) {
          setQuote(v);
          setError(null);
        }
      })
      .catch((e) => {
        if (current() && own === quoteGeneration.current)
          setError(e instanceof Error ? e.message : "暂未取得报价，请重试");
      });
    return () => {
      quoteGeneration.current = own + 1;
    };
  }, [selection, policy, current]);
  const activePolicy = quote?.policy ?? policy;
  const noun = activePolicy ? billingCopy(activePolicy.copy.planNounKey, copy) : "";
  const docs = activePolicy ? purchaseAgreements(activePolicy, agreements) : [];
  const eligible = activePolicy && purchaseVisible(activePolicy) && quote?.action === "subscribe";
  function open(channel: string) {
    if (
      !eligible ||
      !quote ||
      !selection ||
      busy ||
      !activePolicy ||
      docs.length !== activePolicy.copy.agreementKeys.length ||
      docs.length === 0
    )
      return;
    if (channel !== "bank_transfer" && channel !== "wechat_jsapi") {
      setError("该付款渠道暂未开放，请联系服务经理");
      return;
    }
    const body = {
      planId: quote.planId,
      ...(quote.months === null ? {} : { months: quote.months }),
      channel,
      expectAmountFen: quote.payFen,
      agreementVersionIds: docs.map((v) => v.currentVersion.agreementVersionId),
    } satisfies Body<"m.paymentOrder.create">;
    intent.current = createPurchaseIntent(api, body, newIdempotencyKey("plan-purchase"), current);
    setConfirming(true);
    setError(null);
  }
  async function confirm() {
    if (!intent.current || intent.current.pending) return;
    setBusy(true);
    setError(null);
    try {
      const order = await intent.current.submit();
      if (order && current()) {
        setConfirming(false);
        if (order.channel === "bank_transfer") setPayment(order);
        else void paymentResult(order.paymentOrderId);
      }
    } catch (e) {
      if (!current()) return;
      const next = changedQuote(e),
        id = existingOrder(e);
      if (next) {
        setQuote(next);
        intent.current = null;
        setConfirming(false);
        setError("报价已更新，请核对后重新确认");
      } else if (id) {
        setExisting(id);
        setConfirming(false);
        intent.current = null;
        setError("已有待处理的付款单，请先查看");
      } else setError(e instanceof Error ? e.message : "暂未建单，请重试");
    } finally {
      if (current()) setBusy(false);
    }
  }
  const select = (value: { planId: string; months: number }) => {
    setQuote(null);
    setConfirming(false);
    intent.current = null;
    setSelection(value);
  };
  const selected = catalog?.items.find((v) => v.planId === selection?.planId);
  return (
    <View className="billing-plan">
      <PageBody>
        {!catalog || !policy ? (
          error ? (
            <LoadError message={error} onRetry={() => setRefresh((v) => v + 1)} />
          ) : (
            <Skeleton />
          )
        ) : (
          <View id="billing-ready">
            {error ? <Note>{error}</Note> : null}
            {existing ? (
              <Button variant="outline" onClick={() => void paymentResult(existing)}>
                查看已有付款单
              </Button>
            ) : null}
            {!activePolicy || !purchaseVisible(activePolicy) ? (
              <Empty title="暂未开放在线购买" description="请联系服务经理了解开通方式" />
            ) : (
              <>
                <View className="billing-plan__stack" ariaRole="radiogroup">
                  {catalog.items.map((plan) => (
                    <OptionCard
                      key={plan.planId}
                      selected={plan.planId === selection?.planId}
                      title={plan.name}
                      extra={
                        plan.monthlyFeeFen === null
                          ? undefined
                          : `${formatMoney(plan.monthlyFeeFen)} / 月`
                      }
                      description={`每月 ${formatInteger(plan.monthlyPoints)} ${billingCopy(activePolicy.copy.pointsNounKey, copy)} · 按原价 ${formatSignedPercent(plan.discountBp).replace("+", "")}`}
                      onClick={() => {
                        const cycle = plan.cyclePrices[0];
                        if (cycle) select({ planId: plan.planId, months: cycle.months });
                      }}
                    >
                      <View className="billing-plan__muted">
                        {planBenefitLabels(plan)} · {plan.maxStores} 家门店 ·{" "}
                        {plan.maxMembers === null ? "不限成员数" : `${plan.maxMembers} 位成员`} ·{" "}
                        {plan.hasMonthlyReport ? "含月度报告" : "不含月度报告"}
                      </View>
                    </OptionCard>
                  ))}
                </View>
                <Card title="选择周期">
                  <View className="billing-plan__cycles">
                    {selected?.cyclePrices.map((cycle) => (
                      <OptionCard
                        key={cycle.months}
                        selected={selection?.months === cycle.months}
                        title={`${cycle.months} 个月`}
                        extra={formatMoney(cycle.priceFen)}
                        onClick={() => select({ planId: selected.planId, months: cycle.months })}
                      />
                    ))}
                  </View>
                </Card>
                {quote ? (
                  <Card title="本次变更">
                    <DescList
                      items={[
                        { label: "开通版本", value: quote.planName },
                        {
                          label: "周期",
                          value: quote.months === null ? "—" : `${quote.months} 个月`,
                        },
                        {
                          label: "有效期",
                          value: quote.newTerm
                            ? `${quote.newTerm.startDate} 至 ${quote.newTerm.endDate}`
                            : "到账后开通",
                        },
                        { label: "每月积分", value: formatInteger(quote.benefits.monthlyPoints) },
                        { label: "应付金额", value: formatMoney(quote.payFen) },
                      ]}
                    />
                    <Note>{quote.formula.text}</Note>
                  </Card>
                ) : (
                  <Skeleton />
                )}
                <View className="billing-plan__agreements">
                  确认付款即同意{" "}
                  {docs.map((doc, i) => (
                    <View key={doc.agreementKey} className="billing-plan__agreement">
                      <TextButton
                        onClick={() =>
                          void Taro.navigateTo({
                            url: `/pages/agreement/index?agreementVersionId=${encodeURIComponent(doc.currentVersion.agreementVersionId)}`,
                          })
                        }
                      >{`${i ? "、" : ""}《${doc.name}》`}</TextButton>
                    </View>
                  ))}
                </View>
                {docs.length !== activePolicy.copy.agreementKeys.length || docs.length === 0 ? (
                  <Note>购买协议暂未加载完整，请重新加载后确认</Note>
                ) : null}
                {enabledChannels(activePolicy).map((channel) => {
                  const hint = channel.hintKey ? billingCopy(channel.hintKey, copy) : "";
                  return hint ? <Note key={channel.code}>{hint}</Note> : null;
                })}
                {eligible ? (
                  <FooterBar>
                    {enabledChannels(activePolicy).map((channel) => (
                      <Button
                        key={channel.code}
                        disabled={
                          busy ||
                          docs.length === 0 ||
                          docs.length !== activePolicy.copy.agreementKeys.length
                        }
                        onClick={() => open(channel.code)}
                      >
                        {channel.code === "bank_transfer" ? "对公转账" : "微信支付"}{" "}
                        {billingCopy(activePolicy.copy.payButtonKey, copy)}{" "}
                        {quote ? formatMoney(quote.payFen) : ""}
                      </Button>
                    ))}
                  </FooterBar>
                ) : null}
              </>
            )}
          </View>
        )}
      </PageBody>
      <Sheet
        visible={confirming}
        title={`确认开通${noun}`}
        description="请核对版本、周期与付款金额"
        closeOnOverlayClick={!busy}
        onClose={() => {
          if (!busy) {
            setConfirming(false);
            intent.current = null;
          }
        }}
        footer={
          <Button block loading={busy} onClick={() => void confirm()}>
            确认付款
          </Button>
        }
      >
        {quote ? (
          <DescList
            items={[
              { label: "版本", value: quote.planName },
              { label: "周期", value: `${quote.months ?? "—"} 个月` },
              { label: "金额", value: formatMoney(quote.payFen) },
            ]}
          />
        ) : null}
        <Note>确认即同意 {docs.map((v) => `《${v.name}》`).join("、")}</Note>
        {error ? <Note>{error}</Note> : null}
      </Sheet>
      <Sheet
        visible={payment !== null}
        title="对公转账"
        description="请按以下账户转账，并备注付款单号"
        onClose={() => {
          if (payment) void paymentResult(payment.paymentOrderId);
        }}
      >
        {payment ? (
          <>
            <DescList
              items={[
                { label: "应付金额", value: formatMoney(payment.amountFen) },
                { label: "户名", value: payment.bankAccount?.accountName ?? "—" },
                { label: "开户行", value: payment.bankAccount?.bankName ?? "—" },
                {
                  label: "银行账号",
                  value:
                    payment.bankAccount?.accountNo ?? payment.bankAccount?.accountNoMask ?? "—",
                },
                {
                  label: "转账备注",
                  value: payment.bankAccount?.transferRemark ?? payment.orderNo,
                },
              ]}
            />
            <TextButton
              onClick={() =>
                void Taro.setClipboardData({
                  data: `${payment.bankAccount?.accountName ?? ""}\n${payment.bankAccount?.bankName ?? ""}\n${payment.bankAccount?.accountNo ?? ""}\n${payment.bankAccount?.transferRemark ?? payment.orderNo}`,
                })
              }
            >
              复制账户与转账备注
            </TextButton>
            <Note>转账后上传银行回单，财务核对到账后开通</Note>
            {payment.actions.includes("submit-proof") ? (
              <ReceiptPicker
                key={payment.paymentOrderId}
                payment={payment}
                api={api}
                onSubmitted={(v) => void paymentResult(v.paymentOrderId)}
              />
            ) : (
              <Button variant="outline" onClick={() => void paymentResult(payment.paymentOrderId)}>
                查看付款结果
              </Button>
            )}
          </>
        ) : null}
      </Sheet>
    </View>
  );
}
