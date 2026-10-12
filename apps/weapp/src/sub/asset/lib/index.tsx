import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Image, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, usePullDownRefresh, useReachBottom } from "@tarojs/taro";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { Empty } from "@/components/Empty";
import { InfoTag } from "@/components/InfoTag";
import { ListFooter } from "@/components/ListFooter";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { SearchBar } from "@/components/SearchBar";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag, merchantStatusByEnum, merchantStatusByState } from "@/components/StatusTag";
import { Tabs } from "@/components/Tabs";
import { TextButton } from "@/components/TextButton";
import { account, useAccount } from "@/lib/account-runtime";
import { request } from "@/lib/runtime";
import type { RequestLayer } from "@/lib/request";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { assetTitle, createAssetApi, type AssetTab } from "../private/api";
import { assetScope, createAssetResource } from "../private/resource";
import "./index.scss";

let offline: RequestLayer["request"] | null = null;
const call: RequestLayer["request"] = async (path, options) => {
  if (process.env.TARO_ENV === "h5") {
    const scene = (globalThis as { __LYX_ASSET_SHOT__?: string }).__LYX_ASSET_SHOT__;
    if (scene) {
      offline ??= (await import("../../../../shots/asset-fixtures")).offlineAssetRequest(scene);
      return offline(path, options);
    }
  }
  return request(path, options);
};
const api = createAssetApi(call);
const scope = () =>
  assetScope(
    useSessionStore.getState().accessToken,
    useContextStore.getState(),
    account.snapshot().me,
  );
const TABS: { key: AssetTab; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "image", label: "图片" },
  { key: "video", label: "视频" },
  { key: "recording", label: "录音" },
  { key: "audio", label: "音频" },
  { key: "document", label: "文档" },
  { key: "text", label: "文字" },
];
const STATUS = [
  "organizing",
  "adopted",
  "ready",
  "need_portrait_auth",
  "need_reshoot",
  "reference_only",
] as const;
const LABELS = ["整理中", "已采用", "可直接使用", "需肖像授权", "需补拍", "仅供参考"];
export default function AssetLibrary() {
  const { me } = useAccount();
  const token = useSessionStore((s) => s.accessToken),
    store = useContextStore();
  const key = assetScope(token, store, me);
  useEffect(() => {
    void account.start().catch(() => undefined);
  }, []);
  return key ? (
    <LibraryContent key={key} />
  ) : (
    <PageBody>
      <Empty title={token ? "请选择当前成员门店" : "登录后查看素材"} />
    </PageBody>
  );
}
function LibraryContent() {
  const ready = useRef(false);
  const [resource] = useState(() => createAssetResource({ api, scope }));
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot, resource.snapshot);
  const [input, setInput] = useState("");
  const [hidden, setHidden] = useState(false);
  const [now, setNow] = useState(Date.now);
  const load = useCallback(() => {
    setNow(Date.now());
    return resource.prepare(account.start);
  }, [resource]);
  useEffect(() => {
    void resource.prepare(account.start).finally(() => {
      if (resource.current()) {
        setNow(Date.now());
        ready.current = true;
      }
    });
    return () => resource.dispose();
  }, [resource]);
  useDidShow(() => {
    setHidden(false);
    if (ready.current) void load();
  });
  useDidHide(() => {
    setHidden(true);
    resource.suspend();
  });
  usePullDownRefresh(() => {
    void load().finally(() => {
      if (resource.current()) Taro.stopPullDownRefresh();
    });
  });
  useReachBottom(() => {
    void resource.more();
  });
  const summary = state.summary,
    page = state.page;
  const change = (patch: Partial<typeof state.filters>) => {
    void resource.change({ ...state.filters, ...patch });
  };
  const selected = state.filters.tag;
  const hot = summary?.hotTags ?? [];
  return (
    <View
      className="asset-lib"
      id={!state.loading && !state.summaryLoading ? "asset-ready" : undefined}
    >
      <Tabs
        items={TABS.map((tab) => ({ ...tab, badge: summary?.tabs[tab.key] }))}
        value={state.tab}
        onChange={(tab) => {
          void resource.change(state.filters, tab);
        }}
      />
      <PageBody>
        <SearchBar
          value={input}
          placeholder="搜索素材，最多30字"
          onChange={setInput}
          onConfirm={() => change({ q: input })}
        />
        <View className="asset-lib__filters">
          <TextButton onClick={() => change({ q: input })}>搜索</TextButton>
          <Chip
            selected={state.filters.uploader === "me"}
            onClick={() => change({ uploader: state.filters.uploader ? undefined : "me" })}
          >
            我上传的
          </Chip>
          {STATUS.map((status, n) => (
            <Chip
              key={status}
              selected={state.filters.status === status}
              onClick={() =>
                change({ status: state.filters.status === status ? undefined : status })
              }
            >
              {LABELS[n]}
            </Chip>
          ))}
        </View>
        {summary ? (
          <Note>
            {summary.tabs.all} 条素材 · 整理中 {summary.organizingCount} 条 · 已采用{" "}
            {summary.adoptedCount} 条 · 近7天 {summary.recent7dCount} 条
          </Note>
        ) : state.summaryError ? (
          <LoadError
            message={state.summaryError}
            onRetry={() => {
              void resource.refresh();
            }}
          />
        ) : null}
        <View className="asset-lib__tags">
          {hot.map((tag) => (
            <Chip
              key={tag.tag.code}
              selected={selected === tag.tag.code}
              onClick={() => change({ tag: selected === tag.tag.code ? undefined : tag.tag.code })}
            >
              {tag.tag.name} · {tag.assetCount}
            </Chip>
          ))}
          {selected && !hot.some((tag) => tag.tag.code === selected) ? (
            <Chip selected onClick={() => change({ tag: undefined })}>
              已选标签 · 清除
            </Chip>
          ) : null}
        </View>
        {state.loading && !page ? (
          <Skeleton cards={3} media />
        ) : state.error ? (
          <LoadError
            message={state.error}
            onRetry={() => {
              void resource.refresh();
            }}
          />
        ) : page?.items.length === 0 ? (
          <Empty
            title={
              Object.values(state.filters).some(Boolean) ? "没有符合筛选条件的素材" : "还没有素材"
            }
            description="此处展示当前门店的素材与整理结果"
          />
        ) : null}
        {page?.items.map((item) => {
          const label = LABELS[STATUS.indexOf(item.displayStatus)],
            status = merchantStatusByState("store-asset", label ?? "已整理");
          return (
            <Card key={item.storeAssetId} className="asset-lib__item">
              <View
                className="asset-lib__card"
                ariaRole="button"
                ariaLabel={`查看${assetTitle(item)}`}
                onClick={() => {
                  if (resource.current())
                    void Taro.navigateTo({
                      url: `/sub/asset/detail/index?storeAssetId=${encodeURIComponent(item.storeAssetId)}`,
                    });
                }}
              >
                {item.thumbnail && !hidden && Date.parse(item.thumbnail.expiresAt) > now ? (
                  <Image className="asset-lib__image" src={item.thumbnail.url} mode="aspectFit" />
                ) : (
                  <View className="asset-lib__image">
                    {TABS.find((tab) => tab.key === item.type)?.label ?? "素材"}
                  </View>
                )}
                <View className="asset-lib__facts">
                  <View className="asset-lib__title">{assetTitle(item)}</View>
                  <StatusTag tone={status?.tone ?? "neutral"}>{label ?? "已整理"}</StatusTag>
                  <View className="asset-lib__muted">
                    {item.uploader.displayName ?? "上传人"} ·{" "}
                    {item.uploader.role === "owner"
                      ? "老板"
                      : item.uploader.role === "clerk"
                        ? "店员"
                        : "服务人员"}{" "}
                    · {item.createdAt.slice(0, 10)}
                  </View>
                  <View className="asset-lib__muted">
                    {item.fileCount}份 · 采用{item.adoptedCount}次
                    {item.pageCount !== null ? ` · ${item.pageCount}页` : ""}
                    {item.techSpecLabel ? ` · ${item.techSpecLabel}` : ""}
                    {item.structuredItemCount !== null ? ` · ${item.structuredItemCount}项` : ""}
                  </View>
                </View>
              </View>
              {item.quote ? <View className="asset-lib__quote">{item.quote}</View> : null}
              <View className="asset-lib__tags">
                {item.tags.map((tag) => (
                  <Chip
                    key={`${tag.dimension}:${tag.tag.code}`}
                    onClick={() => change({ tag: tag.tag.code })}
                  >
                    {tag.tag.name}
                  </Chip>
                ))}
                {item.isSelectableAsReference ? <InfoTag>可作参考</InfoTag> : null}
                <Text className="asset-lib__muted">
                  {merchantStatusByEnum("store_asset.processing_state", item.processingState)
                    ?.label ?? "整理状态待确认"}{" "}
                  · {item.reviewState === "reviewed" ? "已复核" : "未复核"}
                </Text>
              </View>
            </Card>
          );
        })}
        {state.moreError ? (
          <LoadError
            message={state.moreError}
            onRetry={() => {
              void resource.more();
            }}
          />
        ) : page?.hasMore ? (
          <TextButton
            disabled={state.moreLoading}
            onClick={() => {
              void resource.more();
            }}
          >
            加载更多
          </TextButton>
        ) : null}
        {page?.items.length ? (
          <ListFooter
            status={state.moreLoading ? "loading" : "done"}
            doneText={page.hasMore ? "上拉加载更多" : "已经到底了"}
          />
        ) : null}
      </PageBody>
    </View>
  );
}
