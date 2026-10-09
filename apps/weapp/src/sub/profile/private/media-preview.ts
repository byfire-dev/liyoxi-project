export interface PreviewImage {
  readonly fileId: string;
  readonly src?: string | null;
}
export interface PreviewDownloadResult {
  readonly statusCode: number;
  readonly tempFilePath?: string;
}
export interface PreviewDownload {
  readonly promise: Promise<PreviewDownloadResult>;
  abort(): void;
}
export type PreviewDownloader = (url: string) => PreviewDownload;
type Entry = {
  source: string;
  state: "pending" | "ready" | "failed";
  path?: string;
  task?: PreviewDownload;
};
export interface PreviewSnapshot {
  readonly context: string;
  readonly images: Readonly<Record<string, Readonly<Omit<Entry, "task">>>>;
}
export const PREVIEW_FAILURE = "图片加载失败，请重新进入本页再试";
const remote = (source: string) => /^https?:\/\//i.test(source);

/** 只限活动下载的并发；不共享图片、签名地址或门店缓存。 */
export function createPreviewDownloader(download: PreviewDownloader, concurrency = 3) {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("图片下载并发数须为正整数");
  const queue: Array<() => void> = [];
  let running = 0;
  const pump = () => {
    while (running < concurrency && queue.length) queue.shift()!();
  };
  return (url: string): PreviewDownload => {
    let task: PreviewDownload | undefined;
    let started = false;
    let settled = false;
    let resolve!: (result: PreviewDownloadResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<PreviewDownloadResult>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const finish = (result?: PreviewDownloadResult) => {
      if (settled) return;
      settled = true;
      if (started) running--;
      if (result) resolve(result);
      else reject(new Error(PREVIEW_FAILURE));
      pump();
    };
    const start = () => {
      if (settled) return;
      started = true;
      running++;
      try {
        task = download(url);
        void task.promise.then(
          (result) => finish(result),
          () => finish(),
        );
      } catch {
        finish();
      }
    };
    queue.push(start);
    pump();
    return {
      promise,
      abort() {
        if (settled) return;
        const queued = queue.indexOf(start);
        if (queued !== -1) queue.splice(queued, 1);
        try {
          task?.abort();
        } catch {
          // 取消端口失败也不能让已离开页面的结果重新显示。
        }
        finish();
      },
    };
  };
}

/** 当前图片身份由 fileId + 完整源地址确定；旧下载不能替换新地址。 */
export function createMediaPreview({
  context,
  download,
}: {
  context(): string;
  download: PreviewDownloader;
}) {
  let live = true;
  let currentContext = context();
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let state: PreviewSnapshot = { context: currentContext, images: {} };
  const publish = () => {
    state = {
      context: currentContext,
      images: Object.fromEntries(
        [...entries].map(([id, { source, path, state }]) => [id, { source, path, state }]),
      ),
    };
    for (const listener of listeners) listener();
  };
  const remove = (id: string) => {
    const old = entries.get(id);
    entries.delete(id);
    old?.task?.abort();
  };
  const reset = () => {
    currentContext = context();
    for (const id of entries.keys()) remove(id);
    publish();
  };
  const setImages = (images: readonly PreviewImage[]) => {
    if (!live) return;
    if (currentContext !== context()) reset();
    const desired = new Map(
      images.flatMap((image) => (image.src ? [[image.fileId, image.src] as const] : [])),
    );
    let changed = false;
    for (const [id, entry] of entries)
      if (desired.get(id) !== entry.source) {
        remove(id);
        changed = true;
      }
    for (const [id, source] of desired) {
      if (entries.has(id)) continue;
      changed = true;
      const entry: Entry = remote(source)
        ? { source, state: "pending" }
        : { source, state: "ready", path: source };
      entries.set(id, entry);
      if (entry.state !== "pending") continue;
      const requestedContext = currentContext;
      const isCurrent = () => live && context() === requestedContext && entries.get(id) === entry;
      const failed = () => {
        if (!isCurrent()) return;
        entry.state = "failed";
        delete entry.task;
        publish();
      };
      try {
        entry.task = download(source);
        void entry.task.promise.then((result) => {
          if (!isCurrent()) return;
          if (result.statusCode !== 200 || !result.tempFilePath?.trim()) {
            failed();
            return;
          }
          entry.path = result.tempFilePath;
          entry.state = "ready";
          delete entry.task;
          publish();
        }, failed);
      } catch {
        failed();
      }
    }
    if (changed) publish();
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setImages,
    reset,
    retry() {
      if (!live) return;
      if (currentContext !== context()) {
        reset();
        return;
      }
      const images = [...entries].map(([fileId, entry]) => ({ fileId, src: entry.source }));
      for (const [id, entry] of entries) if (entry.state === "failed") remove(id);
      setImages(images);
    },
    activate() {
      live = true;
      if (currentContext !== context()) reset();
    },
    dispose() {
      live = false;
      for (const id of entries.keys()) remove(id);
      state = { context: currentContext, images: {} };
    },
  };
}

/** React effect 尚未跟上新 props 时，也不显示旧 URL / 旧上下文的图片。 */
export function mediaPreviewView(
  state: PreviewSnapshot,
  images: readonly PreviewImage[],
  context: string,
) {
  if (state.context !== context)
    return {
      sources: {} as Record<string, string>,
      pending: images.some((image) => Boolean(image.src)),
      message: null,
    };
  const sources: Record<string, string> = {};
  let pending = false;
  let failed = false;
  for (const { fileId, src } of images) {
    if (!src) continue;
    if (!remote(src)) {
      sources[fileId] = src;
      continue;
    }
    const entry = state.images[fileId];
    if (!entry || entry.source !== src) pending = true;
    else if (entry.state === "ready" && entry.path) sources[fileId] = entry.path;
    else if (entry.state === "failed") failed = true;
    else pending = true;
  }
  return { sources, pending, message: failed ? PREVIEW_FAILURE : null };
}
