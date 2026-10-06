import { useEffect, useRef, useState } from "react";
import { View } from "@tarojs/components";
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
      <PageBody>
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
            <Card
              title="选剧单"
              extra={
                <Button size="sm" variant="secondary" onClick={() => setEditing((v) => !v)}>
                  {editing ? "完成编辑" : "编辑选剧单"}
                </Button>
              }
            >
              <View className="cart-page__muted">
                {cart.plan
                  ? `${cart.plan.planName} · 套餐折扣 ${formatSignedPercent(cart.plan.discountBp).replace("+", "")}`
                  : "暂无有效套餐权益"}{" "}
                · 最多 {cart.limit} 部
              </View>
            </Card>
            <Note>可用积分 {formatInteger(cart.spendablePoints)}，合计以确认页报价为准。</Note>
            {cart.items.map((item) => (
              <Card key={item.cartItemId}>
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
                    <View className="cart-page__title">{item.drama.title}</View>
                    <View className="cart-page__muted">
                      {item.drama.totalEpisodes} 集 ·{" "}
                      {item.drama.genres.map((g) => g.name).join("、")}
                    </View>
                    <View>
                      原价 {formatInteger(item.currentPricePoints ?? item.snapshotPricePoints)} 积分
                    </View>
                    <View className="cart-page__points">
                      {item.discountedPoints === null
                        ? item.state === "invalid"
                          ? "暂不可订购"
                          : "暂无实扣报价"
                        : `实扣 ${formatInteger(item.discountedPoints)} 积分`}
                    </View>
                  </View>
                </View>
                {item.state === "invalid" ? (
                  <Note>
                    {item.invalidReason === "not_listed"
                      ? "已下架"
                      : item.invalidReason === "stopped"
                        ? "已停止订购"
                        : "暂不可订购"}
                    ，请移出选剧单
                  </Note>
                ) : item.state === "price_changed" ? (
                  <Note>
                    加入时原价 {formatInteger(item.snapshotPricePoints)} 积分，当前原价{" "}
                    {formatInteger(item.currentPricePoints!)} 积分，确认后可选择。
                  </Note>
                ) : null}
                <View className="cart-page__actions">
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
            <Note>确认订购即将开放，当前可保存与整理选剧单。</Note>
            <FooterBar
              aboveTabBar
              equal={false}
              className={process.env.TARO_ENV === "h5" ? "cart-page__footer-h5" : undefined}
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
                <View>{total === null ? "待确认价格" : `${formatInteger(total)} 积分`}</View>
                <View className="cart-page__muted">已选 {selected.length} 部</View>
              </View>
              <Button disabled size="sm">
                订购即将开放
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
