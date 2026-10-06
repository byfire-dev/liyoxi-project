import { useEffect, useRef, useState } from "react";
import Taro from "@tarojs/taro";
import { UPLOAD_LIMITS } from "@liyoxi/shared/uploads";
import { Note } from "@/components/Note";
import { UploadGrid, type UploadItem } from "@/components/UploadGrid";
import { withPrivacy } from "@/lib/runtime";
import { createTaroUpload, prepareTaroFile } from "@/lib/upload/taro";
import { createPublishLifetime } from "@/stores/publish";
export interface Screenshot {
  fileId: string;
  src: string;
}
type Job = ReturnType<typeof createTaroUpload>;
export function Screenshots({
  files,
  onChange,
  disabled = false,
}: {
  files: Screenshot[];
  onChange(files: Screenshot[]): void;
  disabled?: boolean;
}) {
  const [life] = useState(createPublishLifetime),
    [pending, setPending] = useState<{ job: Job; src: string; key: string }[]>([]),
    [message, setMessage] = useState<string | null>(null),
    [revision, setRevision] = useState(0);
  const jobs = useRef<Job[]>([]),
    selecting = useRef(false),
    latest = useRef(files),
    changed = useRef(onChange);
  useEffect(() => {
    latest.current = files;
    changed.current = onChange;
  }, [files, onChange]);
  useEffect(() => {
    life.mount();
    const activeJobs = jobs.current;
    return () => {
      life.dispose();
      for (const job of activeJobs) job.dispose();
    };
  }, [life]);
  const finish = async (entry: { job: Job; src: string; key: string }, retry = false) => {
    const current = life.capture();
    const result = await (retry ? entry.job.retry() : entry.job.start());
    if (!current() || !result) return;
    const next = [...latest.current, { fileId: result.fileId, src: entry.src }].slice(0, 3);
    latest.current = next;
    changed.current(next);
    setPending((items) => items.filter((i) => i !== entry));
    entry.job.dispose();
  };
  const add = async () => {
    if (disabled || selecting.current || latest.current.length + pending.length >= 3) return;
    selecting.current = true;
    setMessage(null);
    const current = life.capture();
    try {
      if (
        process.env.TARO_ENV === "h5" &&
        (globalThis as { __LYX_PUBLISH_SHOT__?: string }).__LYX_PUBLISH_SHOT__
      ) {
        const result = await withPrivacy(
          async () => (await import("../../../../shots/publish-fixtures")).publishScreenshot,
        );
        if (current() && result.ok) {
          const next = [...latest.current, result.value].slice(0, 3);
          latest.current = next;
          changed.current(next);
        }
        return;
      }
      const selected = await withPrivacy(() =>
        Taro.chooseMedia({
          count: 3 - latest.current.length - pending.length,
          mediaType: ["image"],
          sizeType: ["compressed"],
        }),
      );
      if (!selected.ok) {
        if (current()) setMessage("请先同意隐私指引，再选择截图");
        return;
      }
      for (const chosen of selected.value.tempFiles) {
        if (!current()) break;
        const info = await Taro.getImageInfo({ src: chosen.tempFilePath });
        const file = await prepareTaroFile(
          {
            path: chosen.tempFilePath,
            name: `screenshot.${info.type}`,
            size: chosen.size,
            width: chosen.width ?? info.width,
            height: chosen.height ?? info.height,
          },
          "channel_screenshot",
        );
        if (!current()) break;
        if (!file) continue;
        const job = createTaroUpload(file, "channel_screenshot");
        jobs.current.push(job);
        job.subscribe(() => {
          if (current()) setRevision((v) => v + 1);
        });
        const entry = { job, src: file.path, key: `screenshot-${jobs.current.length}` };
        setPending((items) => [...items, entry]);
        await finish(entry);
      }
    } catch (e: unknown) {
      if (current()) setMessage(e instanceof Error ? e.message : "选择截图失败，请重试");
    } finally {
      selecting.current = false;
    }
  };
  const items: UploadItem[] = [
    ...files.map((f) => ({ key: f.fileId, src: f.src })),
    ...pending.map((p) => ({
      key: p.key,
      src: p.src,
      status: ["failed", "cancelled", "paused"].includes(p.job.snapshot().status)
        ? ("failed" as const)
        : ("uploading" as const),
      progress: p.job.snapshot().progress,
    })),
  ];
  return (
    <>
      <UploadGrid
        className={`accounts-uploads-${revision}`}
        items={items}
        max={3}
        disabled={disabled}
        addText="添加主页截图"
        onAdd={() => {
          void add();
        }}
        onRemove={(key) => {
          const entry = pending.find((p) => p.key === key);
          if (entry) {
            void entry.job.cancel().catch(() => setMessage("已停止上传，请重新选择"));
            setPending((p) => p.filter((i) => i !== entry));
          } else {
            const next = files.filter((f) => f.fileId !== key);
            latest.current = next;
            changed.current(next);
          }
        }}
        onRetry={(key) => {
          const entry = pending.find((p) => p.key === key);
          if (entry) void finish(entry, true);
        }}
        onPreview={(key) => {
          const f = files.find((i) => i.fileId === key);
          if (f) void Taro.previewImage({ urls: files.map((i) => i.src), current: f.src });
        }}
      />
      <Note>
        请上传包含账号名称、账号 ID 和认证信息的主页截图，支持 JPG、PNG，每张不超过
        {UPLOAD_LIMITS.imageMaxMb}MB，最多3张
      </Note>
      {message ? <Note tone="warning">{message}</Note> : null}
      {pending.map((entry) =>
        entry.job.snapshot().message ? (
          <Note key={entry.key} tone="warning">
            {entry.job.snapshot().message}
          </Note>
        ) : null,
      )}
      {pending.some((p) => !["failed", "cancelled", "paused"].includes(p.job.snapshot().status)) ? (
        <Note>上传中请勿切出，入库完成后才能提交</Note>
      ) : null}
    </>
  );
}
