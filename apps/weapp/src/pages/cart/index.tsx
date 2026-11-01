import { useEffect, useRef, useState } from "react";
import { Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { formatInteger, formatSignedPercent } from "@liyoxi/shared/format/money";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Checkbox } from "@/components/Checkbox";
import { Cover } from "@/components/Cover";
import { Empty } from "@/components/Empty";
import { FooterBar } from "@/components/FooterBar";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Sheet } from "@/components/Sheet";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag, merchantStatusByState } from "@/components/StatusTag";
import { account } from "@/lib/account-runtime";
import { gotoAccountLogin } from "@/lib/account-routing";
import { ApiError } from "@/lib/request";
import { newIdempotencyKey } from "@/lib/runtime";
import {
  catalogScope,
  cartForRole,
  cartIntent,
  selectedPoints,
  useCatalogStore,
  viewerRole,
  type CartIntent,
  type CartItem,
} from "@/stores/catalog";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { catalogApi } from "../mall/api";
import { openDrama } from "../mall/cards";
import { useCatalogResource, useCatalogBadge } from "../mall/resource";
import "./index.scss";
export default function CartPage() {
  const rev = useContextStore((s) => s.contextRev),
    token = useSessionStore((s) => s.accessToken);
  return <CartContent key={`${rev}:${token}`} />;
}
function CartContent() {
  useCatalogBadge();
  const resource = useCatalogResource(async () => {
      const role = viewerRole(account.snapshot().me, catalogScope());
      return { role, cart: await cartForRole(role, catalogApi.cart) };
    }),
    cart = resource.data?.cart;
  const [selection, setSelected] = useState<string[]>([]),
    [editing, setEditing] = useState(false),
    [operation, setOperation] = useState<{
      action: CartIntent["action"];
      item: CartItem;
      price: number | null;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const active = useRef(false),
    intent = useRef<CartIntent | null>(null);
  const selected = selection.filter((id) =>
    cart?.items.some(
      (i) => i.cartItemId === id && i.state === "valid" && i.discountedPoints !== null,
    ),
  );
  const guard = resource.guard;
  useEffect(() => {
    if (cart && guard()()) useCatalogStore.getState().reconcileCart(cart.items);
  }, [cart, guard]);
  const close = () => {
    if (!active.current) {
      setOperation(null);
      setError(null);
      intent.current = null;
    }
  };
  const confirm = async () => {
    if (!operation || active.current || (operation.action === "accept" && operation.price === null))
      return;
    const current = resource.guard(),
      own = cartIntent(
        intent.current,
        operation.action,
        operation.item.cartItemId,
        operation.price,
        () => newIdempotencyKey(`cart_${operation.action}`),
      );
    intent.current = own;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      if (own.action === "delete") await catalogApi.remove(own.id, own.key);
      else await catalogApi.accept(own.id, own.price!, own.key);
      if (!current()) return;
      if (own.action === "delete") {
        useCatalogStore.getState().removed(own.id, operation.item.state !== "invalid");
        setSelected((ids) => ids.filter((id) => id !== own.id));
      } else useCatalogStore.getState().changed();
      setOperation(null);
      intent.current = null;
      resource.refresh(); // C50首响应/重放均GET真实列表，不补造签名URL。
    } catch (e: unknown) {
      if (!current()) return;
      if (e instanceof ApiError && e.error === "CART_PRICE_CHANGED") {
        const details = e.details;
        if (
          typeof details === "object" &&
          details !== null &&
          "currentPricePoints" in details &&
          typeof details.currentPricePoints === "number"
        ) {
          setOperation({ ...operation, price: details.currentPricePoints });
          intent.current = null;
        }
        setError("价格已更新，请重新核对并确认");
      } else setError(e instanceof Error ? e.message : "操作失败，请重试");
    } finally {
      if (current()) {
        active.current = false;
        setBusy(false);
      }
    }
  };
  const total = cart ? selectedPoints(cart.items, selected) : null;
  const validIds =
    cart?.items
      .filter((i) => i.state === "valid" && i.discountedPoints !== null)
      .map((i) => i.cartItemId) ?? [];
  return (
    <View className="cart-page" id={resource.data ? "catalog-ready" : undefined}>
      <PageBody className="cart-page__content">
        {resource.error ? (
          <LoadError
            message={resource.error}
            onRetry={resource.refresh}
            retrying={resource.loading}
          />
        ) : null}
        {!resource.data ? (
          <Skeleton cards={3} />
        ) : resource.data.role === "clerk" ? (
          <Empty
            title="仅老板可订购"
            description="店员可在商城浏览短剧"
            actionText="去选剧"
            onAction={() => {
              void Taro.switchTab({ url: "/pages/mall/index" });
            }}
          />
        ) : resource.data.role === "guest" ? (
          <Empty
            title="登录后管理选剧单"
            actionText="去登录"
            onAction={() => {
              void gotoAccountLogin();
            }}
          />
        ) : !cart || cart.items.length === 0 ? (
          <Empty
            title="暂无选剧"
            actionText="去选剧"
            onAction={() => {
              void Taro.switchTab({ url: "/pages/mall/index" });
            }}
          />
        ) : (
          <>
            <Note tone="info" className="cart-page__explanation">
              <View>
                {cart.plan
                  ? `实扣积分按当前套餐（${cart.plan.planName} · 折扣 ${formatSignedPercent(cart.plan.discountBp).replace("+", "")}）计算；`
                  : "暂无有效套餐权益，实扣积分以确认页报价为准；"}
              </View>
              <View>加入选剧单不冻结积分，提交订购时才冻结。</View>
            </Note>
            <View className="cart-page__toolbar">
              <View className="cart-page__muted">
                共 {cart.items.length} 部 · 最多 {cart.limit} 部
              </View>
              <Button size="sm" variant="secondary" onClick={() => setEditing((v) => !v)}>
                {editing ? "完成编辑" : "编辑选剧单"}
              </Button>
            </View>
            {cart.items.map((item) => (
              <Card className="cart-page__item" key={item.cartItemId}>
                <View className="cart-page__row">
                  <Checkbox
                    shape="square"
                    checked={selected.includes(item.cartItemId)}
                    disabled={
                      item.state !== "valid" || item.discountedPoints === null || resource.loading
                    }
                    onChange={(checked) =>
                      setSelected((ids) =>
                        checked
                          ? [...new Set([...ids, item.cartItemId])]
                          : ids.filter((id) => id !== item.cartItemId),
                      )
                    }
                  />
                  <Cover
                    variant="thumb"
                    title={item.drama.title}
                    src={item.drama.posterUrl?.url}
                    invalid={item.state === "invalid"}
                  />
                  <View className="cart-page__body">
                    <View className="cart-page__heading">
                      <View className="cart-page__title">{item.drama.title}</View>
                      {item.state === "invalid" ? (
                        <StatusTag
                          tone={merchantStatusByState("cart-item", "已失效")?.tone ?? "neutral"}
                        >
                          已失效
                        </StatusTag>
                      ) : item.state === "price_changed" ? (
                        <StatusTag tone="warning">积分价已变动</StatusTag>
                      ) : item.state === "valid" ? (
                        <StatusTag tone="neutral">正常</StatusTag>
                      ) : null}
                    </View>
                    <View className="cart-page__muted">
                      {item.drama.genres.length
                        ? `${item.drama.genres.map((genre) => genre.name).join("、")} · `
                        : ""}
                      整部 {item.drama.totalEpisodes} 集
                    </View>
                    {item.state !== "invalid" && item.drama.usableUntilDate ? (
                      <View className="cart-page__muted">
                        可使用至 {item.drama.usableUntilDate}
                      </View>
                    ) : null}
                    {item.state === "invalid" ? (
                      <View className="cart-page__invalid-reason">
                        {item.invalidReason === "not_listed"
                          ? "剧目已下架，无法订购"
                          : item.invalidReason === "stopped"
                            ? "剧目已停止订购"
                            : "暂不可订购"}
                        ，请移出选剧单
                      </View>
                    ) : (
                      <>
                        {item.state === "price_changed" ? (
                          <View className="cart-page__price-notice">
                            积分价由 {formatInteger(item.snapshotPricePoints)} 调整为{" "}
                            {item.currentPricePoints === null
                              ? "暂无报价"
                              : formatInteger(item.currentPricePoints)}
                            ，确认后可选择。
                          </View>
                        ) : null}
                        <View className="cart-page__price-row">
                          <Text className="cart-page__points">
                            {item.discountedPoints === null
                              ? "暂无实扣报价"
                              : `${formatInteger(item.discountedPoints)} 积分`}
                          </Text>
                          <Text className="cart-page__original">
                            原价{" "}
                            {formatInteger(item.currentPricePoints ?? item.snapshotPricePoints)}
                          </Text>
                        </View>
                      </>
                    )}
                  </View>
                </View>
                <View className="cart-page__actions">
                  {item.state !== "invalid" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => openDrama(item.drama.dramaId)}
                    >
                      查看详情
                    </Button>
                  ) : null}
                  {item.state === "price_changed" &&
                  item.actions.includes("accept-price") &&
                  item.currentPricePoints !== null ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={resource.loading}
                      onClick={() => {
                        setOperation({ action: "accept", item, price: item.currentPricePoints });
                        setError(null);
                        intent.current = null;
                      }}
                    >
                      确认新价格
                    </Button>
                  ) : null}
                  {(editing || item.state !== "valid") && item.actions.includes("delete") ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={resource.loading}
                      onClick={() => {
                        setOperation({ action: "delete", item, price: null });
                        setError(null);
                        intent.current = null;
                      }}
                    >
                      移出选剧单
                    </Button>
                  ) : null}
                </View>
              </Card>
            ))}

            <FooterBar
              aboveTabBar
              equal={false}
              className={`cart-page__footer${process.env.TARO_ENV === "h5" ? " cart-page__footer-h5" : ""}`}
            >
              <Checkbox
                shape="square"
                checked={validIds.length > 0 && validIds.every((id) => selected.includes(id))}
                disabled={validIds.length === 0}
                onChange={(checked) => setSelected(checked ? validIds : [])}
              >
                全选
              </Checkbox>
              <View className="cart-page__total">
                <View className="cart-page__total-line">
                  应扣{" "}
                  <Text className="cart-page__total-points">
                    {total === null ? "待确认价格" : formatInteger(total)}
                  </Text>
                  {total === null ? "" : " 积分"}
                </View>
                <View className="cart-page__muted">
                  可用 {formatInteger(cart.spendablePoints)} 积分
                </View>
              </View>
              <Button
                disabled={!selected.length || resource.loading || total === null}
                size="sm"
                onClick={() => {
                  const ids = cart.items
                    .filter((item) => selected.includes(item.cartItemId) && item.state === "valid")
                    .map((item) => item.drama.dramaId);
                  void Taro.navigateTo({
                    url: `/sub/order/checkout/index?dramaIds=${encodeURIComponent(ids.join(","))}`,
                  });
                }}
              >
                确认订购（{selected.length}）
              </Button>
            </FooterBar>
          </>
        )}
      </PageBody>
      <Sheet
        className={process.env.TARO_ENV === "h5" ? "cart-page__sheet-h5" : undefined}
        visible={operation !== null}
        title={operation?.action === "delete" ? "移出选剧单" : "确认新价格"}
        onClose={close}
        closeOnOverlayClick={!busy}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={close}>
              取消
            </Button>
            <Button
              variant={operation?.action === "delete" ? "danger" : "primary"}
              loading={busy}
              onClick={() => {
                void confirm();
              }}
            >
              {operation?.action === "delete" ? "确认移出" : "确认价格"}
            </Button>
          </>
        }
      >
        <View className="cart-page__title">{operation?.item.drama.title}</View>
        {operation?.action === "accept" ? (
          <>
            <View>加入时原价：{formatInteger(operation.item.snapshotPricePoints)} 积分</View>
            <View>
              当前原价：{operation.price === null ? "暂无" : formatInteger(operation.price)} 积分
            </View>
            <View className="cart-page__muted">确认当前原价后，实扣积分仍以服务器报价为准。</View>
          </>
        ) : (
          <View>移出后可在商城重新加入。</View>
        )}
        {error ? <Note>{error}</Note> : null}
      </Sheet>
    </View>
  );
}
