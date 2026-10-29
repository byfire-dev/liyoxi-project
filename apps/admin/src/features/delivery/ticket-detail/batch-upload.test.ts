import { expect, it, vi } from "vitest";
import type { UploadBatchDetail } from "@liyoxi/contract";
import type { BatchApi } from "./batch-api";
import { createBatchSession, createBatchUploader } from "./batch-upload";
import { batchFixture, batchCredentials, batchId, batchItem, batchNow } from "./batch-test.fixture";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(count = 1) {
  const batch = batchFixture({
    state: "uploading",
    items: Array.from({ length: count }, (_, index) => batchItem(index + 1)),
  });
  const api: BatchApi = {
    create: vi.fn(async () => batch),
    get: vi.fn(async () => batch),
    start: vi.fn(async () => batch),
    refresh: vi.fn(async () => batchCredentials()),
    update: vi.fn(async () => batch),
    complete: vi.fn(async (id): Promise<Awaited<ReturnType<BatchApi["complete"]>>> => {
      const item = batch.items.find((row) => row.uploadBatchItemId === id);
      if (!item) throw new Error("fixture item missing");
      return { ...item, fileStatus: "stored", state: "uploaded" };
    }),
    cancel: vi.fn(async () => batch),
    commit: vi.fn(async () => ({ batch, masters: [] })),
  };
  return { batch, api, files: batch.items.map((item) => new File(["x"], item.originalName)) };
}
function cloud() {
  const calls: { method: string; url: URL }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ method: init!.method!, url });
    if (init!.method === "POST" && url.searchParams.has("uploads"))
      return new Response(
        "<InitiateMultipartUploadResult><UploadId>owned-upload</UploadId></InitiateMultipartUploadResult>",
      );
    if (init!.method === "PUT") return new Response("", { headers: { ETag: "part" } });
    return new Response(
      "<CompleteMultipartUploadResult><ETag>complete</ETag></CompleteMultipartUploadResult>",
    );
  };
  return { calls, fetchImpl };
}
function postCredentials(batch: UploadBatchDetail) {
  const expiresAt = new Date(batchNow + 600_000).toISOString();
  return {
    mode: "post" as const,
    bucket: batch.bucket,
    region: batch.region,
    prefix: batch.prefix,
    fileParallel: 3 as const,
    expiresAt,
    posts: batch.items
      .filter((item) => item.state === "pending" && item.fileStatus === "pending")
      .map((item) => ({
        fileId: item.fileId,
        key: item.uploadKey!,
        post: {
          url: `${__LYX_LOCAL_STORAGE_ORIGIN__ || "http://127.0.0.1:9100"}/${batch.bucket}`,
          fields: {
            key: item.uploadKey!,
            "Content-Type": "video/mp4",
            policy: "public-test-policy",
          },
        },
        expiresAt,
      })),
  };
}
function postSetup(purpose: "final_release" | "drama_master" = "final_release") {
  const state = setup();
  state.batch.purpose = purpose;
  state.batch.bucket = "lyx-local-media";
  state.batch.region = "us-east-1";
  vi.mocked(state.api.refresh).mockImplementation(async () => postCredentials(state.batch));
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const progress = vi.fn(),
    settled = vi.fn();
  const uploader = createBatchUploader({
    api: state.api,
    purpose,
    current: () => state.batch,
    now: () => batchNow,
    fetchImpl,
    fileStatus: async (fileId) => ({ fileId, status: "stored" }),
    onProgress: progress,
    onSettled: settled,
  });
  return { ...state, fetchImpl, progress, settled, uploader };
}
it("MinIO 原片 POST 使用真实逐文件表单和本地代理，服务器确认后才报入库完成", async () => {
  const { batch, api, files, fetchImpl, progress, settled, uploader } = postSetup("drama_master");
  uploader.attach(batch, files, true);
  await uploader.run();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, request] = fetchImpl.mock.calls[0]!;
  expect(url).toBe(
    __LYX_LOCAL_STORAGE_ORIGIN__
      ? `/__lyx_local_storage/${batch.bucket}`
      : `http://127.0.0.1:9100/${batch.bucket}`,
  );
  expect(request).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
  expect(request!.body).toBeInstanceOf(FormData);
  const form = request!.body as FormData;
  expect(form.get("key")).toBe(batch.items[0]!.uploadKey);
  expect(form.get("policy")).toBe("public-test-policy");
  expect(form.get("file")).toBeInstanceOf(File);
  expect(api.complete).toHaveBeenCalledWith(
    batch.items[0]!.uploadBatchItemId,
    expect.stringMatching(/^complete:/),
    expect.any(AbortSignal),
  );
  expect(progress).toHaveBeenLastCalledWith(batch.items[0]!.uploadBatchItemId, {
    percent: 100,
    busy: false,
  });
  expect(settled).toHaveBeenCalledTimes(1);
  expect(batch.state).toBe("uploading");
  expect(api.commit).not.toHaveBeenCalled();
  uploader.close();
});
it("POST 缓存仍有效但服务器替换了文件时重新签发，不沿用旧文件 policy", async () => {
  const { batch, api, files, fetchImpl, uploader } = postSetup();
  uploader.attach(batch, files, true);
  await uploader.run();
  const old = batch.items[0]!;
  old.state = "replaced";
  const replacement = { ...batchItem(2), originalName: old.originalName, episodeNo: 1 };
  batch.items.push(replacement);
  uploader.attach(batch, files, true);
  await uploader.run();
  expect(api.refresh).toHaveBeenCalledTimes(2);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect((fetchImpl.mock.calls[1]![1]!.body as FormData).get("key")).toBe(replacement.uploadKey);
  expect(vi.mocked(api.complete).mock.calls.map((call) => call[0])).toEqual([
    old.uploadBatchItemId,
    replacement.uploadBatchItemId,
  ]);
  uploader.close();
});
it.each(["fileId", "key", "form-key", "expired"])(
  "POST 凭据 %s 不匹配当前条目时显示错误，不上传或调用 complete",
  async (invalid) => {
    const { batch, api, files, fetchImpl, progress, uploader } = postSetup();
    const issued = postCredentials(batch),
      post = issued.posts[0]!;
    if (invalid === "fileId") post.fileId = batchId(999);
    if (invalid === "key") post.key = `incoming/b${batchId(99)}/${batchId(999)}.mp4`;
    if (invalid === "form-key") post.post.fields.key = `${batch.prefix}${batchId(999)}.mp4`;
    if (invalid === "expired") post.expiresAt = new Date(batchNow - 1).toISOString();
    vi.mocked(api.refresh).mockResolvedValue(issued);
    uploader.attach(batch, files, true);
    await uploader.run();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(api.complete).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith(
      batch.items[0]!.uploadBatchItemId,
      expect.objectContaining({ busy: false, error: expect.any(String) }),
    );
    uploader.close();
  },
);
it("POST 刷新找回的 pending 文件先由服务器确认已有对象，不再次 POST", async () => {
  const { batch, api, files, fetchImpl, progress, uploader } = postSetup();
  uploader.attach(batch, files, false);
  await uploader.run();
  expect(api.complete).toHaveBeenCalledTimes(1);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(progress).toHaveBeenLastCalledWith(batch.items[0]!.uploadBatchItemId, {
    percent: 100,
    busy: false,
  });
  expect(batch.state).toBe("uploading");
  uploader.close();
});
it("POST 刷新恢复缺对象时保留真实确认错误，不按错误文案自动重写对象", async () => {
  const { batch, api, files, fetchImpl, progress, uploader } = postSetup();
  vi.mocked(api.complete).mockRejectedValue(new Error("UPLOAD_NOT_FOUND：找不到原上传对象"));
  uploader.attach(batch, files, false);
  await uploader.run();
  await uploader.run();
  expect(api.complete).toHaveBeenCalledTimes(2);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(progress).toHaveBeenLastCalledWith(batch.items[0]!.uploadBatchItemId, {
    percent: 0,
    busy: false,
    error: "UPLOAD_NOT_FOUND：找不到原上传对象",
  });
  expect(new Set(vi.mocked(api.complete).mock.calls.map((call) => call[1])).size).toBe(1);
  uploader.close();
});
it("POST 返回失败仍显示上传失败，不能确认文件或冒充入库完成", async () => {
  const { batch, api, files, fetchImpl, progress, uploader } = postSetup();
  fetchImpl.mockResolvedValue(new Response("rejected", { status: 403 }));
  uploader.attach(batch, files, true);
  await uploader.run();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(api.complete).not.toHaveBeenCalled();
  expect(progress).toHaveBeenLastCalledWith(
    batch.items[0]!.uploadBatchItemId,
    expect.objectContaining({ percent: 0, busy: false, error: expect.any(String) }),
  );
  expect(progress.mock.calls.some((call) => call[1].percent === 100)).toBe(false);
  uploader.close();
});
it("真实订阅移除关闭本scope，重新订阅可用新scope，旧GET晚到不能污染", async () => {
  const { api } = setup();
  const delayed = deferred<ReturnType<typeof batchFixture>>();
  vi.mocked(api.get).mockReturnValueOnce(delayed.promise);
  const session = createBatchSession({
    api,
    targetId: batchId(2),
    fileStatus: async (fileId) => ({ fileId, status: "stored" }),
  });
  const listener = vi.fn();
  const unsubscribe = session.subscribe(listener);
  const first = session.getSnapshot().runtime!;
  const pending = first.model.open(batchId(1));
  const oldSignal = vi.mocked(api.get).mock.calls[0]![1]!;
  unsubscribe();
  expect(oldSignal.aborted).toBe(true);
  const stopSecond = session.subscribe(listener);
  const second = session.getSnapshot().runtime!;
  expect(second).not.toBe(first);
  vi.mocked(api.get).mockResolvedValueOnce(batchFixture());
  await second.model.open(batchId(1));
  const calls = listener.mock.calls.length;
  delayed.resolve(batchFixture({ state: "ready" }));
  await pending;
  expect(session.getSnapshot().snapshot.batch?.state).toBe("matching");
  expect(listener).toHaveBeenCalledTimes(calls);
  stopSecond();
  expect(session.getSnapshot().runtime).toBeUndefined();
});
it("三文件并发/批次凭据单飞，4个文件逐个确认实际item，100%不生成ready", async () => {
  const { batch, api, files } = setup(4);
  const entered = deferred<void>();
  const release = deferred<void>();
  let active = 0,
    maximum = 0,
    writes = 0;
  const fake = cloud();
  const fetchImpl: typeof fetch = async (input, init) => {
    if (init!.method !== "PUT") return fake.fetchImpl(input, init);
    active++;
    maximum = Math.max(maximum, active);
    writes++;
    if (writes === 3) entered.resolve();
    try {
      await release.promise;
      return await fake.fetchImpl(input, init);
    } finally {
      active--;
    }
  };
  const progress = vi.fn(),
    settled = vi.fn();
  const uploader = createBatchUploader({
    api,
    current: () => batch,
    now: () => batchNow,
    fetchImpl,
    fileStatus: async (fileId) => ({ fileId, status: "stored" }),
    onProgress: progress,
    onSettled: settled,
  });
  uploader.attach(batch, files, true);
  const pending = uploader.run();
  await entered.promise;
  expect(maximum).toBe(3);
  expect(writes).toBe(3);
  expect(api.refresh).toHaveBeenCalledTimes(1);
  release.resolve();
  await pending;
  expect(writes).toBe(4);
  expect(active).toBe(0);
  expect(api.complete).toHaveBeenCalledTimes(4);
  expect(settled).toHaveBeenCalledTimes(4);
  expect(new Set(vi.mocked(api.complete).mock.calls.map((call) => call[0]))).toEqual(
    new Set(batch.items.map((row) => row.uploadBatchItemId)),
  );
  expect(
    progress.mock.calls.filter((call) => call[1].percent === 100 && call[1].busy === false),
  ).toHaveLength(4);
  expect(batch.state).toBe("uploading");
  expect(api.commit).not.toHaveBeenCalled();
  uploader.close();
});
it("第4项排队期间服务器已替换，三个在途完成后不PUT旧key或确认旧file", async () => {
  const { batch, api, files } = setup(4);
  let current = batch;
  const entered = deferred<void>();
  const release = deferred<void>();
  const fake = cloud();
  let writes = 0;
  const uploader = createBatchUploader({
    api,
    current: () => current,
    now: () => batchNow,
    fileStatus: async (fileId) => ({ fileId, status: "stored" }),
    onProgress: vi.fn(),
    onSettled: vi.fn(),
    fetchImpl: async (input, init) => {
      if (init!.method === "PUT") {
        writes++;
        if (writes === 3) entered.resolve();
        await release.promise;
      }
      return fake.fetchImpl(input, init);
    },
  });
  uploader.attach(batch, files, true);
  const pending = uploader.run();
  await entered.promise;
  const old = batch.items[3]!;
  current = {
    ...batch,
    items: batch.items.map((item) => (item === old ? { ...item, state: "replaced" } : item)),
  };
  release.resolve();
  try {
    await pending;
    expect(writes).toBe(3);
    expect(api.complete).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.complete).mock.calls.map((call) => call[0])).not.toContain(
      old.uploadBatchItemId,
    );
    expect(fake.calls.some((call) => call.url.pathname.endsWith(old.uploadKey!))).toBe(false);
  } finally {
    uploader.close();
  }
});
it("已入库/待体检条目刷新找回时不再次上传或complete，凭据范围错误无云请求", async () => {
  const { batch, api, files } = setup();
  const fake = cloud();
  batch.items[0]!.fileStatus = "stored";
  batch.items[0]!.state = "uploaded";
  const uploader = createBatchUploader({
    api,
    current: () => batch,
    now: () => batchNow,
    fetchImpl: fake.fetchImpl,
    fileStatus: async (fileId) => ({ fileId, status: "stored" }),
    onProgress: vi.fn(),
    onSettled: vi.fn(),
  });
  uploader.attach(batch, files, false);
  await uploader.run();
  expect(fake.calls).toHaveLength(0);
  expect(api.complete).not.toHaveBeenCalled();
  batch.items[0]!.fileStatus = "pending";
  batch.items[0]!.state = "pending";
  vi.mocked(api.refresh).mockResolvedValue({
    ...batchCredentials(),
    prefix: `incoming/b${batchId(99)}/`,
  });
  await uploader.run();
  expect(fake.calls).toHaveLength(0);
  expect(api.complete).not.toHaveBeenCalled();
  uploader.close();
});
it("关闭时续签请求的signal被中止；晚到凭据不构造上传或回写", async () => {
  const { batch, api, files } = setup();
  const delayed = deferred<ReturnType<typeof batchCredentials>>();
  vi.mocked(api.refresh).mockReturnValue(delayed.promise);
  const fake = cloud(),
    progress = vi.fn(),
    settled = vi.fn();
  const uploader = createBatchUploader({
    api,
    current: () => batch,
    now: () => batchNow,
    fetchImpl: fake.fetchImpl,
    fileStatus: async (fileId) => ({ fileId, status: "stored" }),
    onProgress: progress,
    onSettled: settled,
  });
  uploader.attach(batch, files, true);
  const pending = uploader.run();
  expect(api.refresh).toHaveBeenCalledTimes(1);
  const signal = vi.mocked(api.refresh).mock.calls[0]![1]!;
  uploader.close();
  expect(signal.aborted).toBe(true);
  const before = progress.mock.calls.length;
  delayed.resolve(batchCredentials());
  await pending;
  expect(fake.calls).toHaveLength(0);
  expect(api.complete).not.toHaveBeenCalled();
  expect(progress).toHaveBeenCalledTimes(before);
  expect(settled).not.toHaveBeenCalled();
});
it("服务器替换新fileId/key后才允许新Init，旧拒收记录不被重传", async () => {
  const { batch, api, files } = setup();
  const old = batch.items[0]!;
  old.state = "replaced";
  const replacement = { ...batchItem(2), originalName: old.originalName, episodeNo: 1 };
  batch.items.push(replacement);
  const fake = cloud();
  const uploader = createBatchUploader({
    api,
    current: () => batch,
    now: () => batchNow,
    fetchImpl: fake.fetchImpl,
    fileStatus: async (fileId) => ({ fileId, status: "stored" }),
    onProgress: vi.fn(),
    onSettled: vi.fn(),
  });
  uploader.attach(batch, files, true);
  await uploader.run();
  expect(fake.calls.every((call) => call.url.pathname.endsWith(`/${replacement.fileId}.mp4`))).toBe(
    true,
  );
  expect(api.complete).toHaveBeenCalledWith(
    replacement.uploadBatchItemId,
    expect.stringMatching(/^complete:/),
    expect.any(AbortSignal),
  );
  uploader.close();
});

it("已确认promoting释放直传名额，入库等待仍保持真实状态且不伪造ready", async () => {
  const { batch, api, files } = setup(4);
  const stored = deferred<{ fileId: string; status: string }>();
  vi.mocked(api.complete).mockImplementation(async (id) => {
    const item = batch.items.find((row) => row.uploadBatchItemId === id)!;
    return { ...item, fileStatus: "promoting" };
  });
  const fake = cloud(),
    progress = vi.fn();
  const uploader = createBatchUploader({
    api,
    current: () => batch,
    now: () => batchNow,
    fetchImpl: fake.fetchImpl,
    fileStatus: async (fileId) => ({ ...(await stored.promise), fileId }),
    onProgress: progress,
    onSettled: vi.fn(),
  });
  uploader.attach(batch, files, true);
  let settled = false;
  const running = uploader.run().then(() => {
    settled = true;
  });
  try {
    await vi.waitFor(() => expect(api.complete).toHaveBeenCalledTimes(4));
    expect(fake.calls.filter((call) => call.method === "PUT")).toHaveLength(4);
    expect(settled).toBe(false);
    expect(progress.mock.calls.filter((call) => call[1].busy === false)).toHaveLength(0);
    expect(batch.state).toBe("uploading");
    expect(api.commit).not.toHaveBeenCalled();
  } finally {
    stored.resolve({ fileId: "unused", status: "stored" });
    await running;
    uploader.close();
  }
  expect(settled).toBe(true);
  expect(progress.mock.calls.filter((call) => call[1].busy === false)).toHaveLength(4);
});
