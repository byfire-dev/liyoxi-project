import { useEffect, useMemo, useSyncExternalStore } from "react";
import { View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow } from "@tarojs/taro";
import { Card } from "@/components/Card";
import { Checkbox } from "@/components/Checkbox";
import { Empty } from "@/components/Empty";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { Skeleton } from "@/components/Skeleton";
import { TextButton } from "@/components/TextButton";
import { account, useAccount } from "@/lib/account-runtime";
import { useSessionStore } from "@/stores/session";
import { useContextStore } from "@/stores/context";
import { catalogScope, viewerRole } from "@/stores/catalog";
import { assetScope } from "../../asset/private/resource";
import { assetLabels, assetStatuses, assetTitle } from "../../asset/private/api";
import { orderReferenceApi } from "./api";
import { createOrderReferences, type OrderReferences } from "./reference-model";
import "./reference-ui.scss";
const scope = () =>
  viewerRole(account.snapshot().me, catalogScope()) === "owner"
    ? assetScope(
        useSessionStore.getState().accessToken,
        useContextStore.getState(),
        account.snapshot().me,
      )
    : null;
export function useOrderReferences(
  changed?: () => void,
  locked?: () => boolean,
  ids?: readonly string[],
) {
  const { me } = useAccount(),
    token = useSessionStore((s) => s.accessToken),
    context = useContextStore();
  const owner = viewerRole(me, catalogScope()) === "owner" ? assetScope(token, context, me) : null,
    identity = ids?.join(",");
  const model = useMemo(
    () =>
      createOrderReferences({
        api: orderReferenceApi,
        scope: () => (scope() === owner ? owner : null),
        changed,
        locked,
        ids: identity === undefined ? undefined : identity.split(",").filter(Boolean),
      }),
    [owner, identity, changed, locked],
  );
  useEffect(() => {
    void model.refresh();
    return model.dispose;
  }, [model]);
  useDidHide(model.suspend);
  useDidShow(model.resume);
  return model;
}
export function ReferencePicker({
  model,
  disabled,
}: {
  model: OrderReferences;
  disabled: boolean;
}) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  return (
    <Card title="参考素材（选填）">
      <View className="order-reference-picker">
        <Note>最多选择9条，供交付经理了解本次定制需求。需肖像授权的素材也可作为参考。</Note>
        <View>已选 {state.selected.length}/9</View>
        <TextButton
          onClick={() => {
            if (!disabled) void model.refresh();
          }}
        >
          刷新参考素材
        </TextButton>
        {state.selected.length ? (
          <View className="order-reference-selected">
            {state.selected.map((item) => (
              <TextButton
                key={item.storeAssetId}
                onClick={() => {
                  if (!disabled) model.toggle(item.storeAssetId);
                }}
              >
                移除 {assetTitle(item)}
                {item.isSelectableAsReference ? "" : " · 当前不可参考"}
              </TextButton>
            ))}
          </View>
        ) : null}
        {state.loading ? (
          <Skeleton cards={1} />
        ) : state.error ? (
          <LoadError
            message={state.error}
            onRetry={() => {
              void model.refresh();
            }}
          />
        ) : !state.page?.items.length ? (
          <Empty title="暂无可参考素材" />
        ) : (
          state.page.items.map((item) => (
            <Checkbox
              key={item.storeAssetId}
              checked={state.selected.some(
                (selected) => selected.storeAssetId === item.storeAssetId,
              )}
              disabled={
                disabled ||
                state.loading ||
                !item.isSelectableAsReference ||
                (state.selected.length >= 9 &&
                  !state.selected.some((selected) => selected.storeAssetId === item.storeAssetId))
              }
              onChange={() => model.toggle(item.storeAssetId)}
            >
              <View>{assetTitle(item)}</View>
              <Note>
                {assetLabels[item.type]} · {assetStatuses[item.displayStatus]}
                {item.isSelectableAsReference ? "" : " · 当前不可参考"}
              </Note>
            </Checkbox>
          ))
        )}
        {state.moreError ? <Note>{state.moreError}</Note> : null}
        {state.page?.hasMore ? (
          <TextButton
            onClick={() => {
              if (!disabled) void model.more();
            }}
          >
            {state.moreLoading ? "加载中…" : "加载更多参考素材"}
          </TextButton>
        ) : null}
      </View>
    </Card>
  );
}
export function OrderReferenceRead({ ids }: { ids: readonly string[] }) {
  const model = useOrderReferences(undefined, undefined, ids);
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  return (
    <Card title="本单参考素材">
      <View className="order-reference-read">
        {state.loading ? (
          <Skeleton cards={1} />
        ) : state.error ? (
          <LoadError
            message="暂时无法查看参考素材，请重试"
            onRetry={() => {
              void model.refresh();
            }}
          />
        ) : !ids.length ? (
          <Note>本单未选参考素材</Note>
        ) : (
          ids.map((id, n) => {
            const item = state.page?.items.find((candidate) => candidate.storeAssetId === id);
            return item ? (
              <View key={id}>
                <TextButton
                  onClick={() => {
                    if (model.current())
                      void Taro.navigateTo({
                        url: `/sub/asset/detail/index?storeAssetId=${encodeURIComponent(id)}`,
                      });
                  }}
                >
                  {assetTitle(item)}
                </TextButton>
                <Note>
                  {assetLabels[item.type]} · {assetStatuses[item.displayStatus]}
                </Note>
              </View>
            ) : (
              <Note key={id}>参考素材{n + 1}已移除或当前无法查看</Note>
            );
          })
        )}
      </View>
    </Card>
  );
}
