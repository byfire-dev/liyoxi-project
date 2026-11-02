import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button as NativeButton, Text, View } from "@tarojs/components";
import Taro, {
  useDidHide,
  useDidShow,
  usePullDownRefresh,
  useRouter,
  useShareAppMessage,
} from "@tarojs/taro";
import { formatInteger } from "@liyoxi/shared/format/money";
import { Button } from "@/components/Button";
import { Cover } from "@/components/Cover";
import { Empty } from "@/components/Empty";
import { Icon } from "@/components/Icon";
import { LoadError } from "@/components/LoadError";
import { Skeleton } from "@/components/Skeleton";
import { account } from "@/lib/account-runtime";
import { useCatalogStore, type DramaDetail } from "@/stores/catalog";
import { flagOn, useBootstrapStore } from "@/stores/bootstrap";
import { openDrama } from "@/pages/mall/cards";
import { trailerApi } from "./api";
import { createTrailerFeed, trailerShare } from "./model";
import { TrailerPlayer } from "./player";
import { useTrailerIdentity, trailerScopeKey } from "./scope";
import "./index.scss";

export default function TrailerPage() {
  const identity = useTrailerIdentity(),
    { dramaId } = useRouter().params;
  return <TrailerGate key={`${identity}:${dramaId ?? ""}`} initialId={dramaId} />;
}
function TrailerGate({ initialId }: { initialId?: string }) {
  const feedEnabled = useBootstrapStore((state) => state.data.flags["weapp.trailer.feed"] === true);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void account
      .start()
      .catch(() => undefined)
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  if (!ready)
    return (
      <View className="trailer-page">
        <View className="trailer-page__state">
          <Skeleton cards={2} />
        </View>
      </View>
    );
  if (!feedEnabled)
    return (
      <View className="trailer-page" id="trailer-ready">
        <View className="trailer-page__state">
          <View className="trailer-page__title">预告片模式暂未开放</View>
          <View className="trailer-page__hint">可在短剧商城浏览剧目和详情</View>
          <Button
            variant="secondary"
            onClick={() => {
              void Taro.switchTab({ url: "/pages/mall/index" });
            }}
          >
            返回列表
          </Button>
        </View>
      </View>
    );
  return <TrailerContent initialId={initialId} />;
}
function TrailerContent({ initialId }: { initialId?: string }) {
  const [model] = useState(() =>
    createTrailerFeed({
      api: trailerApi,
      scope: trailerScopeKey,
      enabled: () => flagOn("weapp.trailer.feed"),
    }),
  );
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const hidden = useRef(false);
  useEffect(() => {
    void model.start(initialId);
    return () => {
      model.dispose();
    };
  }, [model, initialId]);
  useDidHide(() => {
    hidden.current = true;
    model.hide();
  });
  useDidShow(() => {
    if (!hidden.current) return;
    hidden.current = false;
    model.show();
    void model.retry();
  });
  usePullDownRefresh(() => {
    void model.refresh().finally(() => Taro.stopPullDownRefresh());
  });
  useShareAppMessage(() => trailerShare(model.snapshot().detail));
  const detail = state.detail;
  const atEnd = Boolean(
    state.page && state.index >= state.page.items.length - 1 && !state.page.hasMore,
  );
  const back = () => {
    void Taro.switchTab({ url: "/pages/mall/index" });
  };
  const next = () => {
    void model.next();
  };
  return (
    <View
      className="trailer-page"
      id={!state.loading && !state.nextLoading ? "trailer-ready" : undefined}
    >
      <View className="trailer-page__top">
        <Button variant="secondary" size="sm" icon="chevron-left" onClick={back}>
          列表
        </Button>
        <View className="trailer-page__hint">按商城默认排序浏览</View>
      </View>
      {state.error ? (
        <View className="trailer-page__state">
          <LoadError
            message={state.error}
            onRetry={() => {
              void model.retry();
            }}
          />
        </View>
      ) : state.loading ? (
        <View className="trailer-page__state">
          <Skeleton cards={2} />
        </View>
      ) : detail ? (
        <>
          <TrailerActions
            key={detail.dramaId}
            detail={detail}
            current={model.capture}
            playerBlocked={state.nextLoading}
            nextDisabled={atEnd || state.needsRefresh || state.nextLoading}
            atEnd={atEnd}
            onNext={next}
          />
          {state.nextLoading ? (
            <View className="trailer-page__hint trailer-page__feedback">正在加载下一部……</View>
          ) : null}
        </>
      ) : !state.error ? (
        <View className="trailer-page__state">
          <Empty
            title="暂无短剧"
            description="商城暂时没有可浏览的短剧"
            actionText="返回列表"
            onAction={back}
          />
        </View>
      ) : null}
      {state.nextError ? (
        <View className="trailer-page__state">
          <LoadError
            message={state.nextError}
            retryText={state.needsRefresh ? "刷新列表" : "重试下一部"}
            onRetry={() => {
              if (state.needsRefresh) void model.refresh();
              else next();
            }}
          />
        </View>
      ) : null}
    </View>
  );
}
function TrailerFacts({ detail }: { detail: DramaDetail }) {
  return (
    <View className="trailer-page__facts">
      <View className="trailer-page__custom">订购后为您的门店单独定制</View>
      <View className="trailer-page__title">《{detail.title}》</View>
      <View className="trailer-page__meta">
        {detail.genres.map((genre) => genre.name).join(" · ")} · {detail.totalEpisodes} 集
        {detail.heatTier ? ` · 选用量等级 ${detail.heatTier}` : ""}
      </View>
      {detail.synopsis ? <View className="trailer-page__synopsis">{detail.synopsis}</View> : null}
      <View className="trailer-page__prices">
        <Text className="trailer-page__price">
          {detail.listPricePoints === null
            ? "暂无报价"
            : `${formatInteger(detail.listPricePoints)} 积分`}
        </Text>
        {detail.viewerRole === "owner" && detail.discountedPoints !== null ? (
          <Text className="trailer-page__deduction">
            {detail.owner?.planName ? `${detail.owner.planName} ` : ""}实扣{" "}
            {formatInteger(detail.discountedPoints)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
function TrailerActions({
  detail,
  current,
  playerBlocked,
  nextDisabled,
  atEnd,
  onNext,
}: {
  detail: DramaDetail;
  current(): () => boolean;
  playerBlocked: boolean;
  nextDisabled: boolean;
  atEnd: boolean;
  onNext(): void;
}) {
  const [busy, setBusy] = useState(false),
    [added, setAdded] = useState(false),
    [error, setError] = useState<string | null>(null);
  const canAdd = detail.viewerRole === "owner" && detail.orderability.orderable;
  const isAdded = added || Boolean(detail.viewerRole === "owner" && detail.owner?.cartItemId);
  const active = useRef(false),
    alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const add = async () => {
    if (detail.viewerRole !== "owner" || !detail.orderability.orderable || active.current) return;
    const captured = current(),
      valid = () => alive.current && captured();
    if (!valid()) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      const item = await trailerApi.add(detail.dramaId);
      if (!valid()) return;
      useCatalogStore.getState().added(item.cartItemId, Boolean(detail.owner?.cartItemId));
      setAdded(true);
      const cart = await trailerApi.cart();
      if (!valid()) return;
      useCatalogStore.getState().reconcileCart(cart.items);
      void Taro.showToast({ title: "已加入选剧单", icon: "none" });
    } catch (failure) {
      if (valid()) setError(failure instanceof Error ? failure.message : "加入失败，请重试");
    } finally {
      if (valid()) {
        active.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <>
      <View className="trailer-page__stage">
        {detail.trailer ? (
          <TrailerPlayer
            key={`${detail.dramaId}:${detail.trailer.playableId}`}
            trailer={detail.trailer}
            title={detail.title}
            feed
            blocked={playerBlocked}
          >
            <TrailerFacts detail={detail} />
          </TrailerPlayer>
        ) : (
          <View className="trailer-page__poster-stage">
            <Cover
              title={detail.title}
              src={detail.posterUrl?.url}
              className="trailer-page__poster"
            />
            <View className="trailer-page__no-video">本剧暂无预告片，可查看详情或浏览下一部</View>
            <View className="trailer-page__poster-facts">
              <TrailerFacts detail={detail} />
            </View>
          </View>
        )}
        <View className="trailer-page__rail">
          <NativeButton
            className="trailer-page__rail-action"
            hoverClass="trailer-page__rail-action--pressed"
            onClick={() => openDrama(detail.dramaId)}
          >
            <View className="trailer-page__rail-icon">
              <Icon name="file-text" size={24} />
            </View>
            <Text>详情</Text>
          </NativeButton>
          <NativeButton
            className="trailer-page__rail-action"
            hoverClass="trailer-page__rail-action--pressed"
            disabled={!canAdd || busy}
            onClick={add}
          >
            <View className="trailer-page__rail-icon">
              <Icon name={isAdded ? "check" : "plus"} size={24} />
            </View>
            <Text>{busy ? "加入中" : isAdded ? "已在选剧单" : "加选剧单"}</Text>
          </NativeButton>
          <NativeButton
            className="trailer-page__rail-action"
            hoverClass="trailer-page__rail-action--pressed"
            openType="share"
          >
            <View className="trailer-page__rail-icon">
              <Icon name="share" size={24} />
            </View>
            <Text>分享</Text>
          </NativeButton>
          <NativeButton
            className="trailer-page__rail-action"
            hoverClass="trailer-page__rail-action--pressed"
            disabled={nextDisabled}
            onClick={onNext}
          >
            <View className="trailer-page__rail-icon">
              <Icon name="chevron-down" size={24} />
            </View>
            <Text>{atEnd ? "已到最后" : "下一部"}</Text>
          </NativeButton>
        </View>
      </View>
      <View className="trailer-page__bottom">
        <View className="trailer-page__buttons">
          <Button variant="outline" onClick={() => openDrama(detail.dramaId)}>
            查看详情
          </Button>
          {detail.viewerRole === "owner" ? (
            <Button
              loading={busy}
              disabled={!detail.orderability.orderable}
              onClick={() => {
                void add();
              }}
            >
              {added || detail.owner?.cartItemId ? "已在选剧单" : "加入选剧单"}
            </Button>
          ) : null}
        </View>
        {detail.viewerRole !== "owner" ? (
          <View className="trailer-page__hint">仅老板可加入选剧单与订购</View>
        ) : null}
        {!detail.orderability.orderable ? (
          <View className="trailer-page__hint">本剧暂不可订购</View>
        ) : null}
        {error ? <View className="trailer-page__hint">{error}</View> : null}
      </View>
    </>
  );
}
