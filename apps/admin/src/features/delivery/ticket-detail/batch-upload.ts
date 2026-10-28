import type {
  BatchUploadCredentials,
  UploadBatchDetail,
  UploadBatchItemView,
} from "@liyoxi/contract";
import {
  createMultipartUploadAdapter,
  type MultipartUploadGrant,
} from "../../../lib/upload-multipart";
import { localStorageRequestUrl } from "../../../lib/local-storage";
import type { BatchApi } from "./batch-api";
import {
  createBatchModel,
  selectableItem,
  type BatchModel,
  type BatchSnapshot,
} from "./batch-model";

export type BatchFileProgress = { percent: number; busy: boolean; error?: string };

/** Batch credentials stay in this modal's memory; no credential survives navigation. */
export function createBatchUploader(options: {
  api: BatchApi;
  purpose?: "final_release" | "drama_master";
  current: () => UploadBatchDetail | undefined;
  fileStatus: (id: string, signal?: AbortSignal) => Promise<{ fileId: string; status: string }>;
  onProgress: (id: string, progress: BatchFileProgress) => void;
  onSettled: () => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const lifetime = new AbortController();
  const now = options.now ?? Date.now;
  const fresh = new Set<string>();
  const files = new Map<string, File>();
  const adapters = new Map<string, ReturnType<typeof createMultipartUploadAdapter>>();
  const confirmed = new Map<string, () => void>();
  const recoveryKeys = new Map<string, string>();
  let credentials: BatchUploadCredentials | undefined;
  let refresh: Promise<BatchUploadCredentials> | undefined;
  let running = false,
    closed = false;
  const check = () => {
    if (closed) throw new Error("上传已取消");
  };
  const current = () => {
    check();
    const batch = options.current();
    if (!batch || batch.purpose !== (options.purpose ?? "final_release"))
      throw new Error("当前批次不可上传");
    return batch;
  };
  const future = (expiresAt: string, margin = 0) => {
    const expires = Date.parse(expiresAt);
    return Number.isFinite(expires) && expires > now() + margin;
  };
  async function grant(item: UploadBatchItemView): Promise<MultipartUploadGrant> {
    const batch = current(),
      key = item.uploadKey;
    if (
      batch.prefix !== `incoming/b${batch.uploadBatchId}/` ||
      !key ||
      !key.startsWith(batch.prefix) ||
      !key.slice(batch.prefix.length) ||
      key.slice(batch.prefix.length).includes("/")
    )
      throw new Error("文件上传范围不合格");
    const cachedPost =
      credentials?.mode === "post"
        ? credentials.posts.find((post) => post.fileId === item.fileId && post.key === key)
        : undefined;
    if (
      !credentials ||
      !future(credentials.expiresAt, 10_000) ||
      (credentials.mode === "post" && (!cachedPost || !future(cachedPost.expiresAt, 10_000)))
    ) {
      refresh ??= options.api.refresh(batch.uploadBatchId, lifetime.signal).finally(() => {
        refresh = undefined;
      });
      const issued = await refresh;
      check();
      if (
        issued.prefix !== batch.prefix ||
        issued.bucket !== batch.bucket ||
        issued.region !== batch.region ||
        issued.fileParallel !== 3 ||
        !future(issued.expiresAt) ||
        (issued.mode !== "post" &&
          (issued.chunkSize !== 8 * 1024 * 1024 || issued.chunkParallel !== 4))
      )
        throw new Error("批次上传凭据范围或并发参数不一致");
      credentials = issued;
    }
    check();
    const latest = current(),
      live = latest.items.find((row) => row.uploadBatchItemId === item.uploadBatchItemId),
      issued = credentials;
    if (
      latest.uploadBatchId !== batch.uploadBatchId ||
      latest.state !== "uploading" ||
      !live ||
      live.fileId !== item.fileId ||
      live.uploadKey !== key ||
      live.state !== "pending" ||
      live.fileStatus !== "pending" ||
      !issued
    )
      throw new Error("当前文件不可上传，请刷新批次");
    const base = {
      fileId: item.fileId,
      bucket: issued.bucket,
      region: issued.region,
      key,
      prefix: issued.prefix,
    };
    if (issued.mode === "post") {
      const posts = issued.posts.filter((post) => post.fileId === item.fileId),
        post = posts[0];
      if (
        posts.length !== 1 ||
        !post ||
        post.key !== key ||
        post.post.fields.key !== key ||
        !future(post.expiresAt)
      )
        throw new Error("文件上传表单范围或有效期不一致");
      return {
        ...base,
        mode: "post",
        post: post.post,
        sts: null,
        chunkSize: null,
        chunkParallel: null,
        expiresAt: new Date(
          Math.min(Date.parse(issued.expiresAt), Date.parse(post.expiresAt)),
        ).toISOString(),
      };
    }
    return {
      ...base,
      mode: "multipart",
      post: null,
      sts: issued.sts,
      chunkSize: issued.chunkSize,
      chunkParallel: issued.chunkParallel,
      expiresAt: issued.expiresAt,
    };
  }
  async function complete(item: UploadBatchItemView, key: string) {
    const receipt = await options.api.complete(item.uploadBatchItemId, key, lifetime.signal);
    check();
    if (receipt.fileId !== item.fileId) throw new Error("文件归属不一致");
    if (!["promoting", "stored"].includes(receipt.fileStatus))
      throw new Error("文件尚未获服务器确认");
    confirmed.get(item.uploadBatchItemId)?.();
    return { fileId: item.fileId, status: receipt.fileStatus };
  }
  async function recoverPost(item: UploadBatchItemView) {
    let key = recoveryKeys.get(item.uploadBatchItemId);
    if (!key) {
      key = `complete:${crypto.randomUUID()}`;
      recoveryKeys.set(item.uploadBatchItemId, key);
    }
    let status: { fileId: string; status: string } = await complete(item, key);
    // POST has no resumable chunks. Recovery only confirms bytes already on the server.
    for (let poll = 0; status.status === "promoting" && poll < 120; poll++) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new Error("上传已取消"));
        };
        const timer = setTimeout(() => {
          lifetime.signal.removeEventListener("abort", abort);
          resolve();
        }, 1000);
        if (lifetime.signal.aborted) abort();
        else lifetime.signal.addEventListener("abort", abort, { once: true });
      });
      check();
      status = await options.fileStatus(item.fileId, lifetime.signal);
    }
    check();
    if (status.status !== "stored" || status.fileId !== item.fileId)
      throw new Error("文件尚未成功入库");
  }
  async function upload(item: UploadBatchItemView, file: File) {
    check();
    if (item.state !== "pending" || item.fileStatus !== "pending") return;
    options.onProgress(item.uploadBatchItemId, { percent: 0, busy: true });
    try {
      let adapter = adapters.get(item.uploadBatchItemId);
      const restore = !fresh.has(item.uploadBatchItemId) ? { grant: await grant(item) } : undefined;
      check();
      if (restore?.grant.mode === "post") {
        await recoverPost(item);
        check();
        options.onProgress(item.uploadBatchItemId, { percent: 100, busy: false });
        return;
      }
      if (!adapter) {
        const fetchImpl = options.fetchImpl ?? fetch;
        adapter = createMultipartUploadAdapter({
          fetchImpl: (input, init) => {
            if (init?.method === "POST" && init.body instanceof FormData) {
              const url =
                typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
              return fetchImpl(localStorageRequestUrl(url, __LYX_LOCAL_STORAGE_ORIGIN__), {
                ...init,
                credentials: "omit",
              });
            }
            return fetchImpl(input, init);
          },
          now,
          ports: {
            register: () => grant(item),
            refresh: () => grant(item),
            async complete(fileId, key) {
              if (fileId !== item.fileId) throw new Error("文件归属不一致");
              return complete(item, key!);
            },
            get: (fileId) => options.fileStatus(fileId, lifetime.signal),
            cancel: async () => {
              throw new Error("请通过批次操作跳过或替换文件");
            },
          },
        });
        adapters.set(item.uploadBatchItemId, adapter);
      }
      await adapter.upload(
        file,
        {
          onProgress(percent) {
            if (!closed) options.onProgress(item.uploadBatchItemId, { percent, busy: true });
          },
        },
        restore,
      );
      check();
      options.onProgress(item.uploadBatchItemId, { percent: 100, busy: false });
    } catch (error) {
      if (!closed)
        options.onProgress(item.uploadBatchItemId, {
          percent: 0,
          busy: false,
          error: error instanceof Error ? error.message : "上传失败，请重试",
        });
    } finally {
      if (!closed) options.onSettled();
    }
  }
  return {
    /** Called only for server-created rows returned by this modal's create/replacement. */
    attach(batch: UploadBatchDetail, selected: readonly File[], newlyCreated: boolean) {
      check();
      for (const file of selected) {
        const item = selectableItem(batch, file);
        const old = files.get(item.uploadBatchItemId);
        if (old && old !== file) {
          adapters.get(item.uploadBatchItemId)?.close();
          adapters.delete(item.uploadBatchItemId);
          fresh.delete(item.uploadBatchItemId);
        }
        files.set(item.uploadBatchItemId, file);
        if (newlyCreated) fresh.add(item.uploadBatchItemId);
      }
    },
    hasFile: (id: string) => files.has(id),
    async run() {
      if (closed || running) return;
      const batch = current();
      if (batch.state !== "uploading") throw new Error("请先完成匹配并开始批次");
      const queue = batch.items.filter(
        (item) =>
          files.has(item.uploadBatchItemId) &&
          item.state === "pending" &&
          item.fileStatus === "pending",
      );
      running = true;
      let next = 0;
      const completions: Promise<void>[] = [];
      try {
        await Promise.all(
          Array.from({ length: Math.min(3, queue.length) }, async () => {
            while (!closed && next < queue.length) {
              const item = queue[next++]!;
              const latest = current();
              const live = latest.items.find(
                (row) => row.uploadBatchItemId === item.uploadBatchItemId,
              );
              if (
                latest.uploadBatchId !== batch.uploadBatchId ||
                latest.state !== "uploading" ||
                !live ||
                live.fileId !== item.fileId ||
                live.uploadKey !== item.uploadKey ||
                live.state !== "pending" ||
                live.fileStatus !== "pending"
              )
                continue;
              // Only cloud transfer and real server confirmation occupy a transfer slot.
              // Continue the adapter's actual stored check; batch ready still comes from GET.
              let release!: () => void;
              const accepted = new Promise<void>((resolve) => {
                release = resolve;
              });
              confirmed.set(live.uploadBatchItemId, release);
              const completion = upload(live, files.get(live.uploadBatchItemId)!).finally(() => {
                confirmed.delete(live.uploadBatchItemId);
                release();
              });
              completions.push(completion);
              await Promise.race([accepted, completion]);
            }
          }),
        );
        await Promise.all(completions);
      } finally {
        running = false;
      }
    },
    close() {
      closed = true;
      lifetime.abort();
      for (const adapter of adapters.values()) adapter.close();
      adapters.clear();
      files.clear();
      credentials = undefined;
      fresh.clear();
      recoveryKeys.clear();
    },
  };
}
export type BatchUploader = ReturnType<typeof createBatchUploader>;

type BatchView = {
  runtime?: { model: BatchModel; uploader: BatchUploader };
  snapshot: BatchSnapshot;
  progress: Record<string, BatchFileProgress>;
};

/** React subscribes to one private modal lifetime, including development remounts. */
export function createBatchSession(options: {
  api: BatchApi;
  targetId: string;
  purpose?: "final_release" | "drama_master";
  fileStatus: (id: string, signal?: AbortSignal) => Promise<{ fileId: string; status: string }>;
}) {
  const empty = (): BatchView => ({
    snapshot: { pending: false, pollingPaused: false },
    progress: {},
  });
  let view = empty();
  let unsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<BatchView>) => {
    view = { ...view, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!view.runtime) {
        const model = createBatchModel({
          api: options.api,
          targetId: options.targetId,
          purpose: options.purpose,
        });
        const uploader = createBatchUploader({
          api: options.api,
          purpose: options.purpose,
          current: () => model.getSnapshot().batch,
          fileStatus: options.fileStatus,
          onProgress(id, progress) {
            if (view.runtime?.model === model)
              publish({ progress: { ...view.progress, [id]: progress } });
          },
          onSettled() {
            if (view.runtime?.model === model) void model.refresh();
          },
        });
        unsubscribe = model.subscribe(() => {
          if (view.runtime?.model === model) publish({ snapshot: model.getSnapshot() });
        });
        publish({ runtime: { model, uploader }, snapshot: model.getSnapshot(), progress: {} });
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          unsubscribe?.();
          unsubscribe = undefined;
          view.runtime?.uploader.close();
          view.runtime?.model.close();
          view = empty();
        }
      };
    },
  };
}
