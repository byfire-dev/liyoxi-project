import { useEffect, useRef, useState } from "react";
import { View } from "@tarojs/components";
import type { Data } from "@/lib/account-api";
import { Checkbox } from "@/components/Checkbox";
import { TextButton } from "@/components/TextButton";
import { Note } from "@/components/Note";
import { adApi } from "./api";
import { adError } from "./model";
import { deliveryScopeKey } from "@/stores/delivery";
export function AdReferences({
  selected,
  change,
  disabled,
}: {
  selected: string[];
  change(value: string[]): void;
  disabled: boolean;
}) {
  const [page, setPage] = useState<Data<"m.storeAsset.list"> | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    const scope = deliveryScopeKey();
    void Promise.resolve()
      .then(() => {
        if (!live || scope !== deliveryScopeKey()) return null;
        setBusy(true);
        return adApi.references();
      })
      .then((value) => {
        if (value && live && scope === deliveryScopeKey()) {
          setPage(value);
          setError(null);
        }
      })
      .catch((cause) => {
        if (live && scope === deliveryScopeKey()) setError(adError(cause));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [revision]);
  return (
    <View>
      <Note>参考素材选填，最多9条。已选{selected.length}条。</Note>
      {error ? (
        <TextButton onClick={() => setRevision((n) => n + 1)}>重新加载参考素材</TextButton>
      ) : null}
      {error ? <Note>{error}</Note> : null}
      {page?.items.map((item) => (
        <Checkbox
          key={item.storeAssetId}
          checked={selected.includes(item.storeAssetId)}
          disabled={
            disabled ||
            busy ||
            !item.isSelectableAsReference ||
            (selected.length >= 9 && !selected.includes(item.storeAssetId))
          }
          onChange={(value) =>
            change(
              value
                ? [...selected, item.storeAssetId]
                : selected.filter((id) => id !== item.storeAssetId),
            )
          }
        >
          {item.title ?? "门店参考素材"}
        </Checkbox>
      ))}
      {page?.hasMore && page.nextCursor ? (
        <TextButton
          onClick={() => {
            if (busy || disabled) return;
            const current = deliveryScopeKey();
            setBusy(true);
            void adApi
              .references(page.nextCursor!)
              .then((next) => {
                if (mounted.current && current === deliveryScopeKey())
                  setPage({
                    ...next,
                    items: [
                      ...page.items,
                      ...next.items.filter(
                        (item) => !page.items.some((old) => old.storeAssetId === item.storeAssetId),
                      ),
                    ],
                  });
              })
              .catch((cause) => {
                if (mounted.current && current === deliveryScopeKey()) setError(adError(cause));
              })
              .finally(() => {
                if (mounted.current && current === deliveryScopeKey()) setBusy(false);
              });
          }}
        >
          更多参考素材
        </TextButton>
      ) : null}
    </View>
  );
}
