import { useEffect, useRef, useState } from "react";
import { View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { Note } from "@/components/Note";
import { UploadGrid, type UploadItem } from "@/components/UploadGrid";
import { TextButton } from "@/components/TextButton";
import { withPrivacy } from "@/lib/runtime";
import { createTaroUpload, prepareTaroFile } from "@/lib/upload/taro";
import { profileContext } from "./runtime";
import type { RegisterBody } from "@/lib/upload/api";
import type { UploadJob } from "@/lib/upload/queue";
import type { components } from "@liyoxi/contract/types/merchant";
import { useMediaPreview } from "./use-media-preview";

export type MediaFile = NonNullable<components["schemas"]["MediaFileView"]>;
export function FileGrid({
  files,
  onChange,
  category = "profile_image",
  licenseKind,
  max = 12,
  disabled = false,
  video = false,
  single = false,
}: {
  files: readonly MediaFile[];
  onChange(files: MediaFile[]): void;
  category?: RegisterBody["category"];
  licenseKind?: RegisterBody["licenseKind"];
  max?: number;
  disabled?: boolean;
  video?: boolean;
  single?: boolean;
}) {
  const previews = useMediaPreview(
    files
      .filter((file) => file.kind === "image" || file.coverUrl)
      .map((file) => ({ fileId: file.fileId, src: file.coverUrl ?? file.url })),
  );
  const [pending, setPending] = useState<{ job: UploadJob; src: string; key: string }[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const jobs = useRef<UploadJob[]>([]);
  const latest = useRef(files);
  const changed = useRef(onChange);
  useEffect(() => {
    latest.current = files;
    changed.current = onChange;
  }, [files, onChange]);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(true);
  const selecting = useRef(false);
  useEffect(
    () => () => {
      mounted.current = false;
      for (const job of jobs.current) job.dispose();
    },
    [],
  );
  const finish = async (entry: { job: UploadJob; src: string; key: string }) => {
    const result = await entry.job.start();
    if (!mounted.current || !result) return;
    const next: MediaFile[] = [
      ...(single ? [] : latest.current),
      {
        fileId: result.fileId,
        kind: video ? "video" : "image",
        url: entry.src,
        expiresAt: null,
        coverUrl: null,
        durationMs: null,
        displayWidth: null,
        displayHeight: null,
        moderationState: result.moderationState,
      },
    ];
    latest.current = next;
    changed.current(next);
    setPending((list) => list.filter((item) => item !== entry));
    entry.job.dispose();
  };
  const add = async () => {
    if (selecting.current) return;
    selecting.current = true;
    setMessage(null);
    const context = profileContext();
    try {
      const selected = await withPrivacy(() =>
        Taro.chooseMedia({
          count: Math.min(9, Math.max(1, max - files.length - pending.length)),
          mediaType: [video ? "video" : "image"],
          sizeType: ["compressed"],
        }),
      );
      if (!selected.ok) {
        setMessage("请先同意隐私指引，再选择文件");
        return;
      }
      for (const chosen of selected.value.tempFiles) {
        if (!mounted.current || context !== profileContext()) break;
        const image = !video ? await Taro.getImageInfo({ src: chosen.tempFilePath }) : null;
        const extension = video
          ? (/\.([a-zA-Z0-9]+)$/.exec(chosen.tempFilePath)?.[1] ?? "mp4")
          : (image?.type ?? "jpg");
        const file = await prepareTaroFile(
          {
            path: chosen.tempFilePath,
            name: `upload.${extension}`,
            size: chosen.size,
            width: chosen.width ?? image?.width ?? 0,
            height: chosen.height ?? image?.height ?? 0,
            durationMs: Math.round((chosen.duration ?? 0) * 1000),
          },
          category,
        );
        if (!file) continue;
        if (!mounted.current || context !== profileContext()) break;
        const job = createTaroUpload(file, category, licenseKind);
        jobs.current.push(job);
        job.subscribe(() => {
          if (mounted.current) setRevision((n) => n + 1);
        });
        const entry = {
          job,
          src: file.path,
          key: `${Date.now()}-${jobs.current.length}`,
        };
        setPending((list) => [...list, entry]);
        await finish(entry);
      }
    } catch (failure) {
      if (mounted.current && context === profileContext())
        setMessage(failure instanceof Error ? failure.message : "选择文件失败或已取消，请重试");
    } finally {
      selecting.current = false;
    }
  };
  const items: UploadItem[] = [
    ...files.map((file) => ({
      key: file.fileId,
      src:
        file.kind === "image" || file.coverUrl
          ? previews.sources[file.fileId]
          : (file.url ?? undefined),
    })),
    ...pending.map((entry) => ({
      key: entry.key,
      src: entry.src,
      status: ["failed", "cancelled", "paused"].includes(entry.job.snapshot().status)
        ? ("failed" as const)
        : ("uploading" as const),
      progress: entry.job.snapshot().progress,
    })),
  ];
  return (
    <View data-revision={revision}>
      <UploadGrid
        items={items}
        max={single ? files.length + pending.length + 1 : max}
        addText={single && files.length ? "替换文件" : video ? "添加视频" : "添加照片"}
        disabled={disabled}
        onAdd={() => {
          void add();
        }}
        onRemove={(key) => {
          const entry = pending.find((item) => item.key === key);
          if (entry) {
            void entry.job.cancel().catch(() => setMessage("已停止上传，登记将由服务端清理"));
            setPending((list) => list.filter((item) => item !== entry));
          } else changed.current(files.filter((file) => file.fileId !== key));
        }}
        onRetry={(key) => {
          const entry = pending.find((item) => item.key === key);
          if (entry) void finish(entry);
        }}
        onPreview={(key) => {
          const file = files.find((item) => item.fileId === key);
          const url = file?.kind === "image" ? previews.sources[key] : file?.url;
          if (file && url)
            void Taro.previewMedia({
              sources: [
                {
                  url,
                  type: file.kind === "video" ? "video" : "image",
                  ...(file.coverUrl
                    ? { poster: previews.sources[file.fileId] ?? file.coverUrl }
                    : {}),
                },
              ],
            }).catch(() => setMessage("预览失败，请刷新本页重新取得地址"));
        }}
      />
      {previews.pending ? <Note>图片加载中…</Note> : null}
      {previews.message ? (
        <Note tone="warning">
          {previews.message}
          <TextButton onClick={previews.retry}>重试加载图片</TextButton>
        </Note>
      ) : null}
      {message ? <Note tone="warning">{message}</Note> : null}
      {pending
        .filter((entry) => entry.job.snapshot().message)
        .map((entry) => (
          <Note key={entry.key} tone="warning">
            {entry.job.snapshot().message}
            {entry.job.snapshot().canDelegate ? (
              <View>请联系服务经理代传，或改传较小文件</View>
            ) : null}
          </Note>
        ))}
      {pending.some(
        (entry) => !["failed", "cancelled", "paused"].includes(entry.job.snapshot().status),
      ) ? (
        <Note>上传中请勿切出，入库完成后才能保存</Note>
      ) : null}
    </View>
  );
}
