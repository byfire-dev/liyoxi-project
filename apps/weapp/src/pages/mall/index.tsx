import { useEffect, useRef, useState } from "react";
import { Picker, Text, View } from "@tarojs/components";
import Taro, { useDidShow, useReachBottom } from "@tarojs/taro";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { PageBody } from "@/components/PageBody";
import { Empty } from "@/components/Empty";
import { FilterChips } from "@/components/FilterChips";
import { LoadError } from "@/components/LoadError";
import { Skeleton } from "@/components/Skeleton";
import { ListFooter } from "@/components/ListFooter";
import { track } from "@/lib/runtime";
import { mergeDramaPage, useCatalogStore, type DramaPage, type DramaQuery } from "@/stores/catalog";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { useBootstrapStore, flagOn } from "@/stores/bootstrap";
import { catalogApi } from "./api";
import { useCatalogResource } from "./resource";
import { DramaCards } from "./cards";
import { createCatalogPagination, type CatalogPageRequest } from "./pagination";
import "./catalog.scss";
import "./index.scss";
const sortLabel: Readonly<Record<string, string>> = {
  composite: "综合排序",
  heat: "选用量优先",
  price_asc: "积分从低到高",
  price_desc: "积分从高到低",
  newest: "最新上架",
};
export default function MallPage() {
  const rev = useContextStore((s) => s.contextRev),
    token = useSessionStore((s) => s.accessToken);
  return <MallContent key={`${rev}:${token}`} />;
}
function MallContent() {
  const trailerFeedEnabled = useBootstrapStore(
    (state) => state.data.flags["weapp.trailer.feed"] === true,
  );
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [query, setQuery] = useState<DramaQuery>(() => ({
      category: useCatalogStore.getState().category,
    })),
    [continuation, setContinuation] = useState<{ base: DramaPage; page: DramaPage } | null>(null),
    [moreError, setMoreError] = useState<string | null>(null),
    [pendingPage, setPendingPage] = useState<CatalogPageRequest | null>(null);
  const [pagination] = useState(createCatalogPagination);
  const loadingMore = pendingPage?.valid() ?? false;
  const queryVersion = useRef(0);
  const resource = useCatalogResource(async () => {
    const config = await catalogApi.config();
    const list = await catalogApi.list({
      ...query,
      sort: query.sort ?? config.defaultSort,
      limit: 20,
    });
    return { config, list };
  }, JSON.stringify(query));
  const config = resource.data?.config;
  const base = resource.data?.list;
  const page = continuation?.base === base ? continuation?.page : base;
  const sorts = config?.sorts ?? [];
  const industries = [
    { key: "", label: "全部行业" },
    ...(config?.industries ?? []).map((industry) => ({
      key: industry.code,
      label: industry.name,
    })),
  ];
  const genres = [
    { key: "", label: "全部题材" },
    ...(query.category
      ? (config?.categories.find((category) => category.key === query.category)?.genres ?? [])
      : (config?.genres ?? [])
    ).map((genre) => ({ key: genre.code, label: genre.name })),
  ];
  const episodeBands = [{ key: "", label: "全部集数" }, ...(config?.filters.episodeBands ?? [])];
  const priceBands = [{ key: "", label: "全部积分" }, ...(config?.filters.priceBands ?? [])];
  const extraFilterCount = [query.genreCodes, query.episodeBand, query.priceBand].filter(
    Boolean,
  ).length;
  const change = (patch: Partial<DramaQuery>) => {
    resource.invalidate();
    queryVersion.current++;
    pagination.reset();
    setPendingPage(null);
    setMoreError(null);
    setContinuation(null);
    setQuery((q) => ({ ...q, ...patch, cursor: undefined }));
  };
  useDidShow(() => {
    const value = useCatalogStore.getState().category;
    if (value !== query.category) change({ category: value, genreCodes: undefined });
  });
  useEffect(() => {
    if (resource.data)
      track("mall_view", {
        category: query.category || undefined,
        sort: query.sort ?? resource.data.config.defaultSort,
        mode: "list",
      });
  }, [resource.data, query.category, query.sort]);
  const more = async () => {
    if (!page?.hasMore || !page.nextCursor || resource.loading) return;
    const current = resource.guard(true),
      own = queryVersion.current;
    const request = pagination.begin(() => current() && own === queryVersion.current);
    if (!request) return;
    setPendingPage(request);
    setMoreError(null);
    try {
      const next = await catalogApi.list({
        ...query,
        sort: query.sort ?? config?.defaultSort,
        cursor: page.nextCursor,
        limit: 20,
      });
      if (request.valid()) setContinuation({ base: base!, page: mergeDramaPage(page, next) });
    } catch (error: unknown) {
      if (request.valid())
        setMoreError(error instanceof Error ? error.message : "加载失败，请重试");
    } finally {
      if (request.finish()) setPendingPage(null);
    }
  };
  useReachBottom(() => {
    void more();
  });
  return (
    <View
      className="catalog-page mall-page"
      id={config && page && !resource.loading ? "catalog-ready" : undefined}
    >
      <PageBody className="mall-page__body">
        <View className="mall-page__search-row">
          <Button
            className="mall-page__search"
            variant="secondary"
            size="md"
            icon="search"
            onClick={() => {
              void Taro.navigateTo({ url: "/sub/catalog/search/index?from=mall" });
            }}
          >
            搜索剧名、题材、主演
          </Button>
          {trailerFeedEnabled ? (
            <View className="mall-page__modes">
              <View className="mall-page__mode mall-page__mode--active" ariaRole="tab">
                列表
              </View>
              <View
                className="mall-page__mode"
                ariaRole="tab"
                onClick={() => {
                  if (flagOn("weapp.trailer.feed"))
                    void Taro.navigateTo({ url: "/sub/catalog/trailer/index" });
                }}
              >
                <Icon name="play-circle" size={14} />
                <Text>预告片</Text>
              </View>
            </View>
          ) : null}
        </View>
        {resource.error ? (
          <LoadError
            message={resource.error}
            onRetry={resource.refresh}
            retrying={resource.loading}
          />
        ) : null}
        {config ? (
          <View className="mall-page__filters">
            <FilterChips
              className="mall-page__categories"
              items={[
                { key: "", label: "全部" },
                ...config.categories.map((c) => ({ key: c.key, label: c.name })),
              ]}
              value={query.category ?? ""}
              onChange={(value) => {
                useCatalogStore.getState().setCategory(value);
                change({ category: value, genreCodes: undefined });
              }}
            />
            <View className="mall-page__toolbar">
              <Picker
                className="mall-page__picker mall-sort-picker"
                mode="selector"
                range={sorts.map((sort) => sortLabel[sort] ?? sort)}
                value={Math.max(0, sorts.indexOf(query.sort ?? config.defaultSort))}
                onChange={(event) => {
                  const sort = sorts[Number(event.detail.value)];
                  if (sort) change({ sort });
                }}
              >
                <View className="mall-page__filter-entry">
                  <Text className="mall-page__filter-label">
                    {sortLabel[query.sort ?? config.defaultSort] ?? "综合排序"}
                  </Text>
                  <Icon name="chevron-down" size={14} />
                </View>
              </Picker>
              {config.filters.industry ? (
                <Picker
                  className="mall-page__picker mall-industry-picker"
                  mode="selector"
                  range={industries.map((industry) => industry.label)}
                  value={Math.max(
                    0,
                    industries.findIndex(
                      (industry) => industry.key === (query.industryCodes ?? ""),
                    ),
                  )}
                  onChange={(event) => {
                    const industry = industries[Number(event.detail.value)];
                    if (industry) change({ industryCodes: industry.key });
                  }}
                >
                  <View className="mall-page__filter-entry">
                    <Text className="mall-page__filter-label">
                      {industries.find((industry) => industry.key === query.industryCodes)?.label ??
                        "全部行业"}
                    </Text>
                    <Icon name="chevron-down" size={14} />
                  </View>
                </Picker>
              ) : null}
              {config.filters.genre || config.filters.episodes || config.filters.price ? (
                <View
                  className={`mall-page__filter-entry mall-page__more-filter${extraFilterCount ? " mall-page__filter-entry--selected" : ""}`}
                  ariaRole="button"
                  onClick={() => setFiltersExpanded((value) => !value)}
                >
                  <Icon name="sliders" size={16} />
                  <Text>{extraFilterCount ? `筛选 ${extraFilterCount}` : "筛选"}</Text>
                </View>
              ) : null}
            </View>
            {filtersExpanded ? (
              <View className="mall-page__extra-filters">
                {config.filters.genre ? (
                  <FilterChips
                    items={genres}
                    value={query.genreCodes ?? ""}
                    onChange={(genreCodes) => change({ genreCodes })}
                  />
                ) : null}
                {config.filters.episodes ? (
                  <FilterChips
                    items={episodeBands}
                    value={query.episodeBand ?? ""}
                    onChange={(episodeBand) => change({ episodeBand })}
                  />
                ) : null}
                {config.filters.price ? (
                  <FilterChips
                    items={priceBands}
                    value={query.priceBand ?? ""}
                    onChange={(priceBand) => change({ priceBand })}
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}
        {!page ? (
          <Skeleton cards={2} />
        ) : page.items.length === 0 ? (
          <Empty
            title="没有符合条件的短剧"
            actionText="清除筛选"
            onAction={() => {
              useCatalogStore.getState().setCategory("");
              change({
                category: "",
                genreCodes: undefined,
                industryCodes: undefined,
                episodeBand: undefined,
                priceBand: undefined,
              });
            }}
          />
        ) : (
          <DramaCards items={page.items} presentation="mall" />
        )}
        {page && page.items.length > 0 ? (
          page.hasMore ? (
            <View
              onClick={() => {
                void more();
              }}
            >
              <ListFooter
                status="loading"
                loadingText={loadingMore ? "加载中……" : "继续向下浏览"}
              />
            </View>
          ) : (
            <ListFooter status="done" />
          )
        ) : null}
        {moreError ? (
          <LoadError
            message={moreError}
            onRetry={() => {
              void more();
            }}
          />
        ) : null}
      </PageBody>
    </View>
  );
}
