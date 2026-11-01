import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Taro from "@tarojs/taro";
import { UPLOAD_LIMITS } from "@liyoxi/shared/uploads";
import { Note } from "@/components/Note";
import { UploadGrid } from "@/components/UploadGrid";
import { withPrivacy } from "@/lib/runtime";
import { createTaroUpload, prepareTaroFile } from "@/lib/upload/taro";
import { deliveryScopeKey } from "@/stores/delivery";
import { createFeedbackUpload } from "./feedback";
import type { FeedbackImage } from "./feedback";
type Entry = {
  key: string;
  src: string;
  job: ReturnType<typeof createTaroUpload>;
  upload: ReturnType<typeof createFeedbackUpload>;
};
export function FeedbackImages({
  files,
  onChange,
  onBusy,
  disabled,
}: {
  files: FeedbackImage[];
  onChange(files: FeedbackImage[]): void;
  onBusy(value: boolean): void;
  disabled: boolean;
}) {
  const [pending, setPending] = useState<Entry[]>([]),
    [selecting, setSelecting] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [, redraw] = useState(0),
    all = useRef<Entry[]>([]),
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
    if (disabled || lock.current || latest.current.length + pending.length >= 3) return;
    lock.current = true;
    onBusy(true);
    setSelecting(true);
    setError(null);
    const scope = deliveryScopeKey(),
      current = () => live.current && scope === deliveryScopeKey();
    try {
      if (
        process.env.TARO_ENV === "h5" &&
        (globalThis as { __LYX_DELIVERY_SHOT__?: string }).__LYX_DELIVERY_SHOT__
      ) {
        const image = (await import("../../../../shots/delivery-fixtures")).feedbackScreenshot;
        if (current()) onChange([...latest.current, image].slice(0, 3));
        return;
      }
      const picked = await withPrivacy(() =>
        Taro.chooseMedia({
          count: 3 - latest.current.length - pending.length,
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
            name: `feedback.${info.type}`,
            size: chosen.size,
            width: chosen.width ?? info.width,
            height: chosen.height ?? info.height,
          },
          "ticket_attachment",
        );
        if (!current()) break;
        if (!file) continue;
        const job = createTaroUpload(file, "ticket_attachment");
        const entry: Entry = {
          key: `feedback-${all.current.length}`,
          src: file.path,
          job,
          upload: createFeedbackUpload(job, current, (id) => {
            const next = [...latest.current, { fileId: id, src: file.path }].slice(0, 3);
            latest.current = next;
            onChange(next);
            setPending((previous) => previous.filter((value) => value !== entry));
          }),
        };
        all.current.push(entry);
        job.subscribe(() => {
          if (current()) redraw((value) => value + 1);
        });
        setPending((previous) => [...previous, entry]);
        await entry.upload.finish();
      }
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : "截图上传失败，请重试");
    } finally {
      lock.current = false;
      if (current()) setSelecting(false);
    }
  };
  return (
    <>
      <UploadGrid
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
        max={3}
        disabled={disabled || selecting}
        addText="添加修改截图"
        onAdd={() => {
          void add();
        }}
        onRemove={(key) => {
          const entry = pending.find((value) => value.key === key);
          if (entry) {
            void entry.upload.remove().catch(() => {
              if (live.current) setError("已停止上传，请重新选择");
            });
            setPending((previous) => previous.filter((value) => value !== entry));
          } else {
            const next = latest.current.filter((file) => file.fileId !== key);
            latest.current = next;
            onChange(next);
          }
        }}
        onRetry={(key) => {
          const entry = pending.find((value) => value.key === key);
          if (entry)
            void entry.upload.finish(true).catch((cause) => {
              if (live.current) setError(cause instanceof Error ? cause.message : "截图上传失败");
            });
        }}
        onPreview={(key) => {
          const file = files.find((value) => value.fileId === key);
          if (file)
            void Taro.previewImage({ current: file.src, urls: files.map((value) => value.src) });
        }}
      />
      <Note>
        可上传最多3张修改截图，支持JPG、PNG，每张不超过{UPLOAD_LIMITS.imageMaxMb}
        MB；上传完成后才能提交。
      </Note>
      {error ? <Note tone="warning">{error}</Note> : null}
    </>
  );
}
