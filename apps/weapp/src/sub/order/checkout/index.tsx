import { useEffect, useRef, useState } from "react";
import { View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { formatInteger } from "@liyoxi/shared/format/money";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Checkbox } from "@/components/Checkbox";
import { Chip } from "@/components/Chip";
import { Cover } from "@/components/Cover";
import { DescList } from "@/components/DescList";
import { Empty } from "@/components/Empty";
import { FooterBar } from "@/components/FooterBar";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Skeleton } from "@/components/Skeleton";
import { TextArea } from "@/components/TextArea";
import { TextButton } from "@/components/TextButton";
import { account } from "@/lib/account-runtime";
import { ApiError } from "@/lib/request";
import { newIdempotencyKey, withSubscribe } from "@/lib/runtime";
import { catalogScope, useCatalogStore, viewerRole } from "@/stores/catalog";
import { useContextStore } from "@/stores/context";
import {
  canSubmitOrder,
  createOrderIntent,
  quoteRefreshMessage,
  useOrderStore,
  type OrderQuote,
} from "@/stores/order";
import { useSessionStore } from "@/stores/session";
import { usePublishStore } from "@/stores/publish";
import { orderApi } from "../private/api";
import { useOrderResource } from "../private/resource";
import "./index.scss";
const platformName: Record<string, string> = { douyin: "抖音", wechat_channels: "视频号" };
export default function CheckoutPage() {
  const rev = useContextStore((s) => s.contextRev),
    token = useSessionStore((s) => s.accessToken);
  const ids = (Taro.getCurrentInstance().router?.params.dramaIds ?? "").split(",").filter(Boolean);
  return <Checkout key={`${rev}:${token}`} ids={[...new Set(ids)].slice(0, 50)} />;
}
function Checkout({ ids }: { ids: string[] }) {
  const [selected, setSelected] = useState<string[]>([]),
    [focus, setFocus] = useState<string[]>([]),
    [note, setNote] = useState(""),
    [topModel, setTopModel] = useState(false),
    [agreed, setAgreed] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [submitError, setSubmitError] = useState<string | null>(null);
  const [intent] = useState(() => createOrderIntent(() => newIdempotencyKey("order_submit")));
  const active = useRef(false),
    subscribing = useRef(false),
    selection = useRef(selected),
    model = useRef(topModel),
    previousQuote = useRef<OrderQuote | null>(null);
  useEffect(() => {
    selection.current = selected;
    model.current = topModel;
  }, [selected, topModel]);
  const resource = useOrderResource(
    async () => {
      if (viewerRole(account.snapshot().me, catalogScope()) !== "owner") return null;
      if (!ids.length) return null;
      const [accounts, dict, policy] = await Promise.all([
        orderApi.accounts(),
        orderApi.focus(),
        orderApi.policy(),
      ]);
      let quote: OrderQuote | null = null,
        quoteError: { code: string; message: string } | null = null;
      try {
        quote = await orderApi.quote({
          dramaIds: ids,
          isTopModel: model.current,
          channelAccountIds: selection.current,
        });
      } catch (e: unknown) {
        if (
          e instanceof ApiError &&
          ["SUBSCRIPTION_INACTIVE", "STORE_PROFILE_INCOMPLETE", "STORE_NOT_QUALIFIED"].includes(
            e.error,
          )
        )
          quoteError = { code: e.error, message: e.message };
        else throw e;
      }
      return {
        quote,
        quoteError,
        accounts: accounts.items.filter((i) => i.status === "available"),
        focus:
          dict.items
            .find((i) => i.typeKey === "custom_focus")
            ?.items.filter((i) => i.isSelectable) ?? [],
        policy,
      };
    },
    "",
    () => !active.current && !subscribing.current,
  );
  const data = resource.data,
    quote = data?.quote ?? null,
    guard = resource.guard;
  useEffect(() => {
    if (quote) {
      if (previousQuote.current) intent.changed();
      previousQuote.current = quote;
      const current = guard(true);
      void Promise.resolve().then(() => {
        if (current()) setAgreed(null);
      });
    }
  }, [quote, intent, guard]);
  const change = () => {
    intent.changed();
    setSubmitError(null);
  };
  const selectAccount = (id: string, platform: string, checked: boolean) => {
    if (active.current) return;
    change();
    setAgreed(null);
    const samePlatform = new Set(
      data?.accounts.filter((i) => i.platform === platform).map((i) => i.channelAccountId),
    );
    const next = checked
      ? [...selected.filter((v) => !samePlatform.has(v)), id]
      : selected.filter((v) => v !== id);
    selection.current = next;
    setSelected(next);
    resource.refresh();
  };
  const submit = async () => {
    if (
      active.current ||
      resource.loading ||
      !canSubmitOrder(quote, selected, focus, agreed) ||
      !quote
    ) {
      subscribing.current = false;
      setBusy(false);
      return;
    }
    const current = resource.guard(true),
      key = intent.current();
    if (!current()) return;
    active.current = true;
    setBusy(true);
    setSubmitError(null);
    try {
      const created = await orderApi.create(
        {
          dramaIds: ids,
          isTopModel: topModel,
          channelAccountIds: selected,
          focusCodes: focus,
          ...(note.trim() ? { note: note.trim() } : {}),
          agreementVersionId: quote.agreement.agreementVersionId,
          expect: quote.expect,
        },
        key,
      );
      if (!current()) return;
      // C50重放后的签名字段可能为空；只读取真实GET，再进入结果页。
      const [fresh, cart] = await Promise.all([orderApi.detail(created.orderId), orderApi.cart()]);
      if (!current()) return;
      useOrderStore.getState().changed();
      usePublishStore.getState().changed();
      useCatalogStore.getState().reconcileCart(cart.items);
      useCatalogStore.getState().changed();
      await Taro.redirectTo({
        url: `/sub/order/result/index?type=order&orderId=${encodeURIComponent(fresh.orderId)}`,
      });
    } catch (e: unknown) {
      if (!current()) return;
      const refreshed = quoteRefreshMessage(e);
      if (refreshed) {
        intent.changed();
        setAgreed(null);
        setSubmitError(refreshed);
        active.current = false;
        subscribing.current = false;
        setBusy(false);
        resource.refresh();
      } else setSubmitError(e instanceof Error ? e.message : "订购失败，请重试");
    } finally {
      if (current()) {
        active.current = false;
        subscribing.current = false;
        setBusy(false);
      }
    }
  };
  const allowed = canSubmitOrder(quote, selected, focus, agreed) && !resource.loading;
  return (
    <View className="checkout-page" id={resource.loading ? undefined : "order-ready"}>
      <PageBody>
        {resource.error ? (
          <LoadError
            message={resource.error}
            onRetry={resource.refresh}
            retrying={resource.loading}
          />
        ) : null}
        {!resource.data && resource.loading ? (
          <Skeleton cards={3} />
        ) : !data ? (
          resource.error ? null : (
            <Empty
              title={ids.length ? "仅老板可订购" : "请先选择短剧"}
              actionText="返回选剧单"
              onAction={() => {
                void Taro.switchTab({ url: "/pages/cart/index" });
              }}
            />
          )
        ) : !quote ? (
          <Card title="暂时无法订购">
            <Note>{data.quoteError?.message ?? "请刷新取得报价"}</Note>
            {data.quoteError?.code === "SUBSCRIPTION_INACTIVE" ? (
              data.policy.mode === "in_app" &&
              data.policy.isPriceShown &&
              data.policy.isPurchasePromptAllowed ? (
                <TextButton
                  onClick={() => {
                    void Taro.navigateTo({ url: "/sub/billing/plan-pick/index" });
                  }}
                >
                  查看套餐与积分
                </TextButton>
              ) : null
            ) : (
              <TextButton
                onClick={() => {
                  void Taro.navigateTo({ url: "/sub/profile/profile/index" });
                }}
              >
                完善门店资料
              </TextButton>
            )}
          </Card>
        ) : (
          <>
            <Card title="订购主体">
              <DescList
                items={[
                  { label: "门店", value: quote!.store.storeName ?? "—" },
                  { label: "主体", value: quote!.store.entityName ?? "—" },
                  {
                    label: "联系人",
                    value: `${quote!.store.contactName ?? "—"} ${quote!.store.contactPhoneMask ?? ""}`,
                  },
                ]}
              />
            </Card>
            <Card title="订购剧目">
              {quote!.items.map((item) => (
                <View key={item.drama.dramaId} className="checkout-page__drama">
                  <Cover variant="thumb" title={item.drama.title} src={item.drama.posterUrl?.url} />
                  <View>
                    <View className="checkout-page__title">{item.drama.title}</View>
                    <View className="checkout-page__muted">
                      整部 {item.drama.totalEpisodes} 集 · 可使用至 {item.drama.usableUntilDate}
                    </View>
                    <View>原价 {formatInteger(item.listPricePoints)} 积分</View>
                    <View className="checkout-page__points">
                      实扣 {formatInteger(item.chargePoints)} 积分
                    </View>
                  </View>
                </View>
              ))}
            </Card>
            {quote!.blockers.map((blocker, i) => (
              <Card key={`${blocker.code}:${i}`}>
                <Note>{blocker.message}</Note>
                {blocker.code === "POINTS_INSUFFICIENT" ? (
                  data.policy.mode === "in_app" &&
                  data.policy.isPriceShown &&
                  data.policy.isPurchasePromptAllowed ? (
                    <TextButton
                      onClick={() => {
                        void Taro.navigateTo({ url: "/sub/billing/plan-pick/index" });
                      }}
                    >
                      查看套餐与积分
                    </TextButton>
                  ) : null
                ) : [
                    "STORE_PROFILE_INCOMPLETE",
                    "STORE_NOT_QUALIFIED",
                    "ENTITY_NOT_VERIFIED",
                    "QUALIFICATION_REJECTED",
                  ].includes(blocker.code) ? (
                  <TextButton
                    onClick={() => {
                      void Taro.navigateTo({ url: "/sub/profile/profile/index" });
                    }}
                  >
                    完善门店资料
                  </TextButton>
                ) : blocker.code === "ORDER_ACCOUNT_INVALID" ? (
                  <TextButton
                    onClick={() => {
                      void Taro.navigateTo({ url: "/sub/publish/accounts/index" });
                    }}
                  >
                    管理发布账号
                  </TextButton>
                ) : null}
              </Card>
            ))}
            <Card
              title="发布账号"
              extra={<View className="checkout-page__muted">每个平台最多 1 个</View>}
            >
              {data.accounts.length ? (
                data.accounts.map((item) => {
                  const selectable =
                    quote!.channelAccounts.find((a) => a.channelAccountId === item.channelAccountId)
                      ?.isSelectable === true;
                  return (
                    <Checkbox
                      key={item.channelAccountId}
                      checked={selected.includes(item.channelAccountId)}
                      disabled={busy || resource.loading || !selectable}
                      onChange={(checked) =>
                        selectAccount(item.channelAccountId, item.platform, checked)
                      }
                    >
                      <View>
                        {platformName[item.platform] ?? item.platform} · {item.accountName}
                      </View>
                      <View className="checkout-page__muted">
                        {item.accountUid}
                        {!selectable ? " · 当前剧目不可选择" : ""}
                      </View>
                    </Checkbox>
                  );
                })
              ) : (
                <Empty
                  title="没有可用发布账号"
                  description="账号通过核验后即可选择"
                  actionText="绑定账号"
                  onAction={() => {
                    void Taro.navigateTo({ url: "/sub/publish/accounts/index" });
                  }}
                />
              )}
            </Card>
            <Card title="定制重点">
              <Checkbox
                checked={topModel}
                disabled={busy || resource.loading}
                onChange={(checked) => {
                  if (active.current) return;
                  change();
                  setAgreed(null);
                  model.current = checked;
                  setTopModel(checked);
                  resource.refresh();
                }}
              >
                选用顶级制作模型
              </Checkbox>
              <Note>
                {quote.plan.isTopModelIncluded
                  ? "当前套餐包含顶级制作模型"
                  : "选用后将重新取得服务端报价"}
              </Note>
              <View className="checkout-page__chips">
                {data.focus.map((item) => (
                  <Chip
                    key={item.code}
                    selected={focus.includes(item.code)}
                    disabled={busy}
                    onClick={() => {
                      change();
                      setFocus((prev) =>
                        prev.includes(item.code)
                          ? prev.filter((v) => v !== item.code)
                          : [...prev, item.code],
                      );
                    }}
                  >
                    {item.name}
                  </Chip>
                ))}
              </View>
              <TextArea
                value={note}
                maxLength={200}
                placeholder="补充说明（选填，最多200字）"
                disabled={busy}
                onChange={(value) => {
                  change();
                  setNote(value);
                }}
              />
            </Card>
            <Card title="积分明细">
              <DescList
                items={[
                  { label: "合计实扣", value: `${formatInteger(quote!.totalChargePoints)} 积分` },
                  { label: "可用积分", value: formatInteger(quote!.spendablePoints) },
                  { label: "积分缺口", value: formatInteger(quote!.pointsShortfall) },
                  {
                    label: "套餐积分",
                    value: `${formatInteger(quote!.balanceAfter.planPoints)}（订购后）`,
                  },
                  {
                    label: "加购积分",
                    value: `${formatInteger(quote!.balanceAfter.addonPoints)}（订购后）`,
                  },
                ]}
              />
            </Card>
            <Card title="协议确认">
              <TextButton
                onClick={() => {
                  void Taro.navigateTo({
                    url: `/pages/agreement/index?id=${encodeURIComponent(quote!.agreement.agreementVersionId)}`,
                  });
                }}
              >
                《{quote!.agreement.name}》 · {quote!.agreement.versionLabel}
              </TextButton>
              <Checkbox
                checked={agreed === quote!.agreement.agreementVersionId}
                disabled={busy || resource.loading}
                onChange={(checked) =>
                  setAgreed(checked ? quote!.agreement.agreementVersionId : null)
                }
              >
                我已阅读并同意本次协议
              </Checkbox>
            </Card>
            {submitError ? <Note>{submitError}</Note> : null}
            <FooterBar equal={false}>
              <View className="checkout-page__total">
                {formatInteger(quote!.totalChargePoints)} 积分
              </View>
              <Button
                loading={busy}
                disabled={!allowed}
                onClick={() => {
                  if (subscribing.current || active.current || !allowed) return;
                  subscribing.current = true;
                  withSubscribe("order_submit", submit)();
                  setBusy(true);
                }}
              >
                确认订购
              </Button>
            </FooterBar>
          </>
        )}
      </PageBody>
    </View>
  );
}
