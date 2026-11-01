import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Taro from "@tarojs/taro";
import { Note } from "@/components/Note";
import { UploadGrid } from "@/components/UploadGrid";
import { withPrivacy } from "@/lib/runtime";
import { createTaroUpload, prepareTaroFile } from "@/lib/upload/taro";
import { deliveryScopeKey } from "@/stores/delivery";
import { createFeedbackUpload } from "../../order/sample/feedback";
export type AdImage = { fileId: string; src: string };
type Entry = {
  key: string;
  src: string;
  job: ReturnType<typeof createTaroUpload>;
  upload: ReturnType<typeof createFeedbackUpload>;
};
export function AdImages({
  files,
  onChange,
  onBusy,
  max,
  disabled,
}: {
  files: AdImage[];
  onChange(files: AdImage[]): void;
  onBusy(value: boolean): void;
  max: number;
  disabled: boolean;
}) {
  const [pending, setPending] = useState<Entry[]>([]),
    [selecting, setSelecting] = useState(false),
    [error, setError] = useState<string | null>(null),
    [, redraw] = useState(0);
  const all = useRef<Entry[]>([]),
    live = useRef(true),
    lock = useRef(false),
    latest = useRef(files);
  useLayoutEffect(() => {
    latest.current = files;
  }, [files]);
  useEffect(() => {
    live.current = true;
    const entries = all.current;
    return () => {
      live.current = false;
      for (const entry of entries) entry.upload.dispose();
    };
  }, []);
  useEffect(() => {
    onBusy(selecting || pending.length > 0);
  }, [selecting, pending.length, onBusy]);
  const add = async () => {
    if (disabled || lock.current || latest.current.length + pending.length >= max) return;
    lock.current = true;
    onBusy(true);
    setSelecting(true);
    setError(null);
    const scope = deliveryScopeKey(),
      current = () => live.current && scope === deliveryScopeKey();
    try {
      if (
        process.env.TARO_ENV === "h5" &&
        (globalThis as { __LYX_AD_SHOT__?: string }).__LYX_AD_SHOT__
      ) {
        const image = (await import("../../../../shots/ad-fixtures")).adScreenshot;
        if (current()) onChange([...latest.current, image].slice(0, max));
        return;
      }
      const picked = await withPrivacy(() =>
        Taro.chooseMedia({
          count: Math.min(9, max - latest.current.length - pending.length),
          mediaType: ["image"],
          sizeType: ["compressed"],
        }),
      );
      if (!picked.ok) {
        if (current()) setError("请先同意隐私指引，再选择截图");
        return;
      }
      for (const chosen of picked.value.tempFiles) {
        if (!current()) break;
        const info = await Taro.getImageInfo({ src: chosen.tempFilePath });
        const file = await prepareTaroFile(
          {
            path: chosen.tempFilePath,
            name: `ad-feedback.${info.type}`,
            size: chosen.size,
            width: chosen.width ?? info.width,
            height: chosen.height ?? info.height,
          },
          "ticket_attachment",
        );
        if (!file || !current()) continue;
        const job = createTaroUpload(file, "ticket_attachment");
        const entry: Entry = {
          key: `ad-image-${all.current.length}`,
          src: file.path,
          job,
          upload: createFeedbackUpload(job, current, (id) => {
            const next = [...latest.current, { fileId: id, src: file.path }];
            latest.current = next;
            onChange(next);
            setPending((items) => items.filter((item) => item !== entry));
          }),
        };
        all.current.push(entry);
        job.subscribe(() => {
          if (current()) redraw((n) => n + 1);
        });
        setPending((items) => [...items, entry]);
        await entry.upload.finish();
      }
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : "截图上传失败");
    } finally {
      lock.current = false;
      if (current()) setSelecting(false);
    }
  };
  return (
    <>
      <UploadGrid
        max={max}
        disabled={disabled || selecting}
        addText="添加修改截图"
        items={[
          ...files.map((file) => ({ key: file.fileId, src: file.src })),
          ...pending.map((entry) => ({
            key: entry.key,
            src: entry.src,
            status: ["failed", "cancelled", "paused"].includes(entry.job.snapshot().status)
              ? ("failed" as const)
              : ("uploading" as const),
            progress: entry.job.snapshot().progress,
          })),
        ]}
        onAdd={() => void add()}
        onRemove={(key) => {
          const entry = pending.find((item) => item.key === key);
          if (entry) {
            void entry.upload.remove().catch(() => undefined);
            setPending((items) => items.filter((item) => item !== entry));
          } else {
            const next = latest.current.filter((file) => file.fileId !== key);
            latest.current = next;
            onChange(next);
          }
        }}
        onRetry={(key) => {
          const entry = pending.find((item) => item.key === key);
          if (entry)
            void entry.upload.finish(true).catch(() => {
              if (live.current) setError("截图上传失败，请重试");
            });
        }}
        onPreview={(key) => {
          const file = files.find((item) => item.fileId === key);
          if (file)
            void Taro.previewImage({ current: file.src, urls: files.map((item) => item.src) });
        }}
      />
      <Note>最多{max}张JPG或PNG截图，每张不超过5MB；上传完成后才能提交。</Note>
      {error ? <Note tone="warning">{error}</Note> : null}
    </>
  );
}
