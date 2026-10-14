import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow } from "@tarojs/taro";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { formatInteger } from "@liyoxi/shared/format/money";
import { Card } from "@/components/Card";
import { Empty } from "@/components/Empty";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { Skeleton } from "@/components/Skeleton";
import { TextButton } from "@/components/TextButton";
import { account, useAccount } from "@/lib/account-runtime";
import type { RequestLayer } from "@/lib/request";
import { request } from "@/lib/runtime";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { createHomeAssetsApi } from "./home-assets-api";
import {
  createHomeAssetsResource,
  homeAssetLibraryUrl,
  homeAssetUploadUrl,
  homeAssetsScope,
} from "./home-assets-model";
import "./home-assets.scss";

const call: RequestLayer["request"] = async (path, options) => {
  if (process.env.TARO_ENV === "h5") {
    const scene = (globalThis as { __LYX_ASSET_HOME_SHOT__?: string }).__LYX_ASSET_HOME_SHOT__;
    if (scene) {
      const { offlineHomeAssetsRequest } = await import("../../../../shots/asset-home-fixtures");
      return offlineHomeAssetsRequest(scene)(path, options);
    }
  }
  return request(path, options);
};
const api = createHomeAssetsApi(call);
const scope = () =>
  homeAssetsScope(
    useSessionStore.getState().accessToken,
    useContextStore.getState(),
    account.snapshot().me,
  );

/** 首页本域入口；完整成员范围变化也会卸载旧读取，而非仅比较 storeId。 */
export function HomeAssets() {
  const { me } = useAccount(),
    token = useSessionStore((s) => s.accessToken),
    store = useContextStore();
  const key = homeAssetsScope(token, store, me);
  return key ? <HomeAssetsContent key={key} /> : null;
}
function HomeAssetsContent() {
  const [resource] = useState(() => createHomeAssetsResource({ api, scope }));
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot, resource.snapshot),
    ready = useRef(false);
  const load = () => resource.prepare(account.start);
  useEffect(() => {
    resource.resume();
    void resource.prepare(account.start).finally(() => {
      if (resource.current()) ready.current = true;
    });
    return () => resource.dispose();
  }, [resource]);
  useDidShow(() => {
    resource.resume();
    if (ready.current) void load();
  });
  useDidHide(() => resource.suspend());
  const open = (url: string) => {
    if (resource.current()) void Taro.navigateTo({ url });
  };
  const demands = state.demands,
    summary = state.summary;
  return (
    <View
      className="home-assets"
      id={!state.demandsLoading && !state.summaryLoading ? "asset-home-ready" : undefined}
    >
      <Card
        title="素材需求"
        extra={
          <TextButton arrow onClick={() => open(homeAssetUploadUrl())}>
            上传素材
          </TextButton>
        }
      >
        {state.demandsLoading ? (
          <Skeleton />
        ) : state.demandsError ? (
          <LoadError
            message={state.demandsError}
            onRetry={() => {
              void load();
            }}
          />
        ) : demands?.items.length ? (
          <>
            {demands.items.slice(0, 3).map((item) => (
              <View className="home-assets__demand" key={item.assetDemandId}>
                <View className="home-assets__title">{item.title}</View>
                {item.shootingNote ? (
                  <View className="home-assets__note">{item.shootingNote}</View>
                ) : null}
                <View className="home-assets__meta">
                  {item.createdByName} · {appDateTimeFormat.dateInSentence(item.dueDate)}前完成
                  {item.isOverdue ? " · 已逾期" : ""}
                </View>
                <View className="home-assets__actions">
                  <View className="home-assets__meta">
                    我已上传 {formatInteger(item.myUploadCount)} 条
                  </View>
                  <TextButton arrow onClick={() => open(homeAssetUploadUrl(item.assetDemandId))}>
                    为此需求上传
                  </TextButton>
                </View>
              </View>
            ))}
            {demands.hasMore || demands.items.length > 3 ? (
              <TextButton onClick={() => open(homeAssetUploadUrl())}>查看其他需求</TextButton>
            ) : null}
          </>
        ) : demands ? (
          <Empty title="暂无开放的素材需求" description="也可以主动上传门店日常" />
        ) : null}
      </Card>
      <Card
        title="我上传的"
        extra={
          <TextButton arrow onClick={() => open(homeAssetLibraryUrl())}>
            查看素材
          </TextButton>
        }
      >
        {state.summaryLoading ? (
          <Skeleton />
        ) : state.summaryError ? (
          <LoadError
            message={state.summaryError}
            onRetry={() => {
              void load();
            }}
          />
        ) : summary ? (
          <>
            <View className="home-assets__summary">
              {formatInteger(summary.tabs.all)} 条素材 · {formatInteger(summary.adoptedCount)}{" "}
              条被采用
            </View>
            {summary.tabs.all === 0 ? (
              <Note>上传门店环境与服务素材，方便服务经理了解本店</Note>
            ) : null}
            <View className="home-assets__actions">
              <TextButton onClick={() => open(homeAssetUploadUrl())}>上传新素材</TextButton>
              <TextButton arrow onClick={() => open(homeAssetLibraryUrl(true))}>
                查看被采用的素材
              </TextButton>
            </View>
          </>
        ) : null}
      </Card>
    </View>
  );
}
