import { useEffect, useRef, useState } from "react";
import { View } from "@tarojs/components";
import { useDidShow, useReachBottom } from "@tarojs/taro";
import { Card } from "@/components/Card";
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
import { catalogApi } from "./api";
import { useCatalogResource } from "./resource";
import { DramaCards } from "./cards";
import { createCatalogPagination, type CatalogPageRequest } from "./pagination";
import "./catalog.scss";
const sortLabel: Readonly<Record<string, string>> = {
  composite: "综合",
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
      className="catalog-page"
      id={config && page && !resource.loading ? "catalog-ready" : undefined}
    >
      <PageBody>
        {resource.error ? (
          <LoadError
            message={resource.error}
            onRetry={resource.refresh}
            retrying={resource.loading}
          />
        ) : null}
        {config ? (
          <Card>
            <View className="catalog-filters">
              <FilterChips
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
              <FilterChips
                items={config.sorts.map((sort) => ({ key: sort, label: sortLabel[sort] ?? sort }))}
                value={query.sort ?? config.defaultSort}
                onChange={(sort) => change({ sort })}
              />
              {config.filters.genre ? (
                <FilterChips
                  items={[
                    { key: "", label: "全部题材" },
                    ...(query.category
                      ? (config.categories.find((c) => c.key === query.category)?.genres ?? [])
                      : config.genres
                    ).map((g) => ({ key: g.code, label: g.name })),
                  ]}
                  value={query.genreCodes ?? ""}
                  onChange={(genreCodes) => change({ genreCodes })}
                />
              ) : null}
              {config.filters.industry ? (
                <FilterChips
                  items={[
                    { key: "", label: "全部行业" },
                    ...config.industries.map((g) => ({ key: g.code, label: g.name })),
                  ]}
                  value={query.industryCodes ?? ""}
                  onChange={(industryCodes) => change({ industryCodes })}
                />
              ) : null}
              {config.filters.episodes ? (
                <FilterChips
                  items={[
                    { key: "", label: "全部集数" },
                    ...config.filters.episodeBands.map((b) => ({ key: b.key, label: b.label })),
                  ]}
                  value={query.episodeBand ?? ""}
                  onChange={(episodeBand) => change({ episodeBand })}
                />
              ) : null}
              {config.filters.price ? (
                <FilterChips
                  items={[
                    { key: "", label: "全部积分" },
                    ...config.filters.priceBands.map((b) => ({ key: b.key, label: b.label })),
                  ]}
                  value={query.priceBand ?? ""}
                  onChange={(priceBand) => change({ priceBand })}
                />
              ) : null}
            </View>
          </Card>
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
          <DramaCards items={page.items} />
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
