import { useCallback, useEffect, useRef, useState } from "react";
import { UploadField } from "../../../components/UploadField";
import type { DetailApi } from "./api";
import { createProductionUpload } from "./upload";

function Screenshot({
  api,
  storeId,
  disabled,
  change,
  busy,
}: {
  api: DetailApi;
  storeId: string;
  disabled: boolean;
  change(id: string | null): void;
  busy(value: boolean): void;
}) {
  const lifetime = useRef<
    { active: boolean; adapter: ReturnType<typeof createProductionUpload> } | undefined
  >(undefined);
  useEffect(() => {
    const own = {
      active: true,
      adapter: createProductionUpload(api, {
        category: "ticket_attachment",
        storeId,
        onBehalfStore: true,
      }),
    };
    lifetime.current = own;
    return () => {
      own.active = false;
      own.adapter.dispose();
    };
  }, [api, storeId]);
  const upload = useCallback(
    async (file: File, hooks: { onProgress(value: number): void }) => {
      const own = lifetime.current;
      if (!own?.active) throw new DOMException("上传已取消", "AbortError");
      busy(true);
      try {
        return await own.adapter.upload(file, {
          onProgress: (value) => {
            if (own.active) hooks.onProgress(value);
          },
        });
      } finally {
        if (own.active) busy(false);
      }
    },
    [busy],
  );
  return (
    <UploadField
      rule={{ accept: [".jpg", ".jpeg", ".png"], maxSizeMb: 5 }}
      text="选择反馈截图"
      disabled={disabled}
      upload={upload}
      onChange={(id) => {
        if (lifetime.current?.active) change(id);
      }}
    />
  );
}
export function M5FeedbackUpload({
  api,
  storeId,
  disabled,
  onChange,
  onBusy,
}: {
  api: DetailApi;
  storeId: string;
  disabled: boolean;
  onChange(ids: string[]): void;
  onBusy(value: boolean): void;
}) {
  const [ids, setIds] = useState<Array<string | null>>([null, null, null]),
    pending = useRef(new Set<number>()),
    currentIds = useRef(ids);
  return (
    <fieldset disabled={disabled}>
      <legend>反馈截图（可选，最多3张）</legend>
      {ids.map((_, index) => (
        <Screenshot
          key={index}
          api={api}
          storeId={storeId}
          disabled={disabled}
          change={(id) => {
            const next = currentIds.current.map((old, slot) => (slot === index ? id : old));
            currentIds.current = next;
            setIds(next);
            onChange(next.filter((value): value is string => value !== null));
          }}
          busy={(value) => {
            if (value) pending.current.add(index);
            else pending.current.delete(index);
            onBusy(pending.current.size > 0);
          }}
        />
      ))}
    </fieldset>
  );
}
