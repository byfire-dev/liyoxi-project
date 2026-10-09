import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Text, View } from "@tarojs/components";
import Taro, { useDidShow, usePullDownRefresh, useReachBottom } from "@tarojs/taro";
import { formatInteger } from "@liyoxi/shared/format/money";
import { Button } from "@/components/Button";
import { Cover } from "@/components/Cover";
import { Empty } from "@/components/Empty";
import { Icon } from "@/components/Icon";
import { IconButton } from "@/components/IconButton";
import { Input } from "@/components/Input";
import { ListFooter } from "@/components/ListFooter";
import { LoadError } from "@/components/LoadError";
import { PageBody } from "@/components/PageBody";
import { Skeleton } from "@/components/Skeleton";
import { account } from "@/lib/account-runtime";
import { storage } from "@/lib/platform.taro";
import { request } from "@/lib/runtime";
import type { RequestLayer } from "@/lib/request";
import { createSearchHistory } from "@/lib/search-history";
import { catalogScope, scopeKey } from "@/stores/catalog";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { openDrama } from "@/pages/mall/cards";
import { createSearchApi } from "./api";
import type { SearchCard } from "./api";
import { highlight } from "./model";
import { createSearchResource } from "./resource";
import "./index.scss";

let sceneCall: RequestLayer["request"] | null = null;
const call: RequestLayer["request"] = async (path, options) => {
  if (process.env.TARO_ENV === "h5") {
    const scene = (globalThis as { __LYX_SEARCH_SHOT__?: string }).__LYX_SEARCH_SHOT__;
    if (scene) {
      sceneCall ??= (await import("../../../../shots/search-fixtures")).offlineSearchRequest(scene);
      return sceneCall(path, options);
    }
  }
  return request(path, options);
};
const api = createSearchApi(call),
  history = createSearchHistory(storage);
function Highlight({
  text,
  q,
  matched,
  genre = false,
}: {
  text: string;
  q: string;
  matched: boolean;
  genre?: boolean;
}) {
  return (
    <>
      {highlight(text, q, matched, genre).map((part, n) => (
        <Text key={n} className={part.hit ? "search-page__hit" : undefined}>
          {part.text}
        </Text>
      ))}
    </>
  );
}
function ResultCard({
  item,
  q,
  match,
  owner,
}: {
  item: SearchCard;
  q: string;
  match: boolean;
  owner: boolean;
}) {
  const discount = owner && "discountedPoints" in item ? item.discountedPoints : null;
  return (
    <View
      className="search-page__result"
      ariaRole="button"
      ariaLabel={`查看${item.title}`}
      onClick={() => openDrama(item.dramaId)}
    >
      <Cover
        title={item.title}
        src={item.posterUrl?.url}
        variant="thumb"
        className="search-page__cover"
      />
      <View className="search-page__facts">
        <View className="search-page__title">
          <Highlight
            text={item.title}
            q={q}
            matched={match && item.matchedFields.includes("title")}
          />
        </View>
        <View className="search-page__muted">
          {item.genres.map((genre, n) => (
            <Text key={genre.code}>
              {n ? " · " : ""}
              <Highlight
                text={genre.name}
                q={q}
                genre
                matched={match && item.matchedFields.includes("genre")}
              />
            </Text>
          ))}{" "}
          · {item.totalEpisodes} 集{item.heatTier ? ` · 选用量等级 ${item.heatTier}` : ""}
        </View>
        {match && item.matchedFields.includes("cast") ? (
          <View className="search-page__muted">主演匹配</View>
        ) : null}
        <View className="search-page__prices">
          <Text className="search-page__price">
            {item.listPricePoints === null
              ? "暂无报价"
              : `${formatInteger(item.listPricePoints)} 积分`}
          </Text>
          {discount !== null ? (
            <Text className="search-page__muted">实扣 {formatInteger(discount)} 积分</Text>
          ) : null}
        </View>
        {item.usableUntilDate ? (
          <View className="search-page__muted">可使用至 {item.usableUntilDate}</View>
        ) : null}
      </View>
    </View>
  );
}
export default function SearchPage() {
  const rev = useContextStore((s) => s.contextRev),
    token = useSessionStore((s) => s.accessToken);
  const storeId = useContextStore((s) => s.currentStoreId);
  return <SearchContent key={`${rev}:${token}:${storeId}`} />;
}
function SearchContent() {
  const [controller] = useState(() =>
    createSearchResource({ api, history, scope: () => scopeKey(catalogScope()) }),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const ready = useRef(false);
  useEffect(() => {
    ready.current = false;
    let active = true;
    void account
      .start()
      .catch(() => undefined)
      .then(async () => {
        if (!active) return;
        await controller.config();
        if (active) ready.current = true;
      });
    return () => {
      active = false;
      controller.dispose();
    };
  }, [controller]);
  useDidShow(() => {
    if (!ready.current) return;
    void controller.config();
    if (controller.snapshot().query) void controller.submit();
  });
  usePullDownRefresh(() => {
    void Promise.all([controller.config(), controller.submit()])
      .finally(() => Taro.stopPullDownRefresh())
      .catch(() => undefined);
  });
  useReachBottom(() => {
    void controller.more();
  });
  const hot = state.config?.hotWords.slice(0, 8) ?? [],
    page = state.page;
  const cards: SearchCard[] = page?.items ?? [];
  const goMall = () => {
    if (Taro.getCurrentInstance().router?.params.from === "mall") void Taro.navigateBack();
    else void Taro.switchTab({ url: "/pages/mall/index" });
  };
  return (
    <View
      className="search-page"
      id={!state.configLoading && !state.loading ? "search-ready" : undefined}
    >
      <PageBody>
        <View className="search-page__form">
          <Input
            className="search-page__input"
            value={state.input}
            maxlength={-1}
            placeholder="搜索剧名、题材、主演"
            ariaLabel="搜索短剧"
            confirmType="search"
            onChange={controller.change}
            onConfirm={() => {
              void controller.submit();
            }}
            suffix={
              state.input ? (
                <IconButton icon="close" label="清除搜索词" onClick={() => controller.change("")} />
              ) : (
                <Icon name="search" size={18} />
              )
            }
          />
          <Button
            size="md"
            onClick={() => {
              void controller.submit();
            }}
          >
            搜索
          </Button>
        </View>
        {!state.query ? (
          <>
            {state.history.length ? (
              <View className="search-page__section">
                <View className="search-page__section-head">
                  <Text>搜索历史</Text>
                  <View
                    className="search-page__clear"
                    ariaRole="button"
                    ariaLabel="清空搜索历史"
                    onClick={controller.clearHistory}
                  >
                    <Icon name="trash" size={16} />
                    清空
                  </View>
                </View>
                <View className="search-page__chips">
                  {state.history.map((word) => (
                    <View
                      key={word}
                      className="search-page__chip"
                      ariaRole="button"
                      onClick={() => {
                        void controller.submit(word);
                      }}
                    >
                      {word}
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
            {state.configError ? (
              <LoadError
                message={state.configError}
                onRetry={() => {
                  void controller.config();
                }}
                retrying={state.configLoading}
              />
            ) : state.configLoading ? (
              <Skeleton cards={1} />
            ) : hot.length ? (
              <View className="search-page__hot">
                <View className="search-page__section-head">
                  <Text>热门搜索</Text>
                </View>
                <View className="search-page__hot-grid">
                  {hot.map((word, n) => (
                    <View
                      key={word}
                      className="search-page__hot-word"
                      ariaRole="button"
                      onClick={() => {
                        void controller.submit(word);
                      }}
                    >
                      <Text
                        className={
                          n < 3 ? "search-page__rank search-page__rank--top" : "search-page__rank"
                        }
                      >
                        {n + 1}
                      </Text>
                      <Text>{word}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
            <View className="search-page__muted">支持按剧名、题材、主演搜索。</View>
          </>
        ) : state.error ? (
          <LoadError
            message={state.error}
            onRetry={() => {
              void controller.submit();
            }}
            retrying={state.loading}
          />
        ) : state.loading ? (
          <Skeleton media />
        ) : page ? (
          <>
            {page.mode === "industry_fallback" && page.fallbackIndustry ? (
              <View className="search-page__fallback">
                未找到包含“{state.query}”的短剧，已为您推荐适配{page.fallbackIndustry.name}行业
                {page.fallbackIndustry.keywordCategoryName
                  ? `（${page.fallbackIndustry.keywordCategoryName}）`
                  : ""}
                的短剧。
              </View>
            ) : null}
            {page.items.length ? (
              <>
                <View className="search-page__muted">
                  找到{page.totalApprox === 999 ? "约" : ""} {page.totalApprox} 部短剧
                </View>
                {page.viewerRole === "owner" && page.viewerPlan ? (
                  <View className="search-page__muted">
                    {page.viewerPlan.planName} · 实扣积分以当前报价为准
                  </View>
                ) : null}
                {cards.map((item) => (
                  <ResultCard
                    key={item.dramaId}
                    item={item}
                    q={state.query}
                    match={page.mode === "match"}
                    owner={page.viewerRole === "owner"}
                  />
                ))}
                {state.moreError ? (
                  <>
                    <LoadError
                      message={state.moreError}
                      retryText="重试加载更多"
                      onRetry={() => {
                        void controller.more();
                      }}
                      retrying={state.moreLoading}
                    />
                    <Button
                      variant="secondary"
                      size="md"
                      onClick={() => {
                        void controller.submit();
                      }}
                    >
                      重新搜索
                    </Button>
                  </>
                ) : state.moreLoading ? (
                  <ListFooter status="loading" />
                ) : page.hasMore ? (
                  <Button
                    variant="secondary"
                    size="md"
                    onClick={() => {
                      void controller.more();
                    }}
                  >
                    加载更多
                  </Button>
                ) : (
                  <ListFooter status="done" />
                )}
              </>
            ) : (
              <>
                <Empty
                  title={`没有找到“${state.query}”相关的短剧`}
                  description="换个关键词，或看看大家都在搜什么"
                  actionText="去短剧商城看看"
                  onAction={goMall}
                />
                <View className="search-page__chips">
                  {hot.slice(0, 3).map((word) => (
                    <View
                      key={word}
                      className="search-page__chip"
                      ariaRole="button"
                      onClick={() => {
                        void controller.submit(word);
                      }}
                    >
                      {word}
                    </View>
                  ))}
                </View>
              </>
            )}
          </>
        ) : null}
      </PageBody>
    </View>
  );
}
