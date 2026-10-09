import { afterEach, expect, it, vi } from "vitest";
import type { BatchApi } from "./batch-api";
import {
  canConsume,
  canStart,
  createBatchModel,
  selectableItem,
  selectionProblem,
} from "./batch-model";
import { batchFixture, batchCredentials, batchId } from "./batch-test.fixture";

const completeCoverage = {
  missingEpisodeNos: [],
  duplicateEpisodeNos: [],
  unmatchedItemIds: [],
  needsSequenceConfirm: false,
};
function apiFixture(): BatchApi {
  return {
    create: vi.fn(async () => batchFixture()),
    get: vi.fn(async () => batchFixture()),
    start: vi.fn(async () => batchFixture({ state: "uploading" })),
    refresh: vi.fn(async () => batchCredentials()),
    update: vi.fn(async () => batchFixture()),
    complete: vi.fn(async () => batchFixture().items[0]!),
    cancel: vi.fn(async () => batchFixture({ state: "canceled" })),
    commit: vi.fn(async () => ({ batch: batchFixture(), masters: [] })),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

it("真实20集不能由已选一文件缩小；整部覆盖与人工顺序确认同时守卫", () => {
  const batch = batchFixture();
  expect(batch.expectedCount).toBe(20);
  expect(canStart(batch, true)).toBe(false);
  expect(
    canStart(
      batchFixture({ coverage: { ...completeCoverage, needsSequenceConfirm: true } }),
      false,
    ),
  ).toBe(false);
  expect(
    canStart(batchFixture({ coverage: { ...completeCoverage, needsSequenceConfirm: true } }), true),
  ).toBe(true);
  expect(
    canStart(batchFixture({ coverage: { ...completeCoverage, duplicateEpisodeNos: [1] } }), true),
  ).toBe(false);
  expect(canConsume(batchFixture({ state: "uploading", coverage: completeCoverage }))).toBe(false);
  expect(canConsume(batchFixture({ state: "verifying", coverage: completeCoverage }))).toBe(false);
  expect(canConsume(batchFixture({ state: "ready", coverage: completeCoverage }))).toBe(true);
  expect(
    canConsume(
      batchFixture({ state: "ready", purpose: "drama_master", coverage: completeCoverage }),
    ),
  ).toBe(false);
});
it("只接收原文件精确名称/大小，拒ZIP、空文件、同名以及不属于本批次的恢复", () => {
  expect(selectionProblem([new File(["x"], "archive.zip")])).toContain("类型不支持");
  expect(selectionProblem([new File([], "a.mp4")])).toContain("空");
  expect(selectionProblem([new File(["x"], "a.mp4"), new File(["y"], "a.mp4")])).toContain("重复");
  expect(selectableItem(batchFixture(), new File(["x"], "第1集.mp4")).fileId).toBe(batchId(201));
  expect(() => selectableItem(batchFixture(), new File(["xx"], "第1集.mp4"))).toThrow("名称和大小");
});
it("2秒轮询有界，ready停止；关闭取消timer且旧响应不能回写", async () => {
  vi.useFakeTimers();
  const api = apiFixture();
  vi.mocked(api.get)
    .mockResolvedValueOnce(batchFixture({ state: "uploading" }))
    .mockResolvedValueOnce(batchFixture({ state: "verifying" }))
    .mockResolvedValueOnce(batchFixture({ state: "ready", coverage: completeCoverage }));
  const model = createBatchModel({ api, targetId: batchId(2) });
  await model.open(batchId(1));
  await vi.advanceTimersByTimeAsync(1999);
  expect(api.get).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(api.get).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(model.getSnapshot().batch?.state).toBe("ready");
  await vi.advanceTimersByTimeAsync(10000);
  expect(api.get).toHaveBeenCalledTimes(3);
  model.close();
  expect(vi.getTimerCount()).toBe(0);
});
it("轮询预算耗尽停下，不以超时推断ready；用户刷新恢复真实读取", async () => {
  vi.useFakeTimers();
  const api = apiFixture();
  vi.mocked(api.get).mockResolvedValue(batchFixture({ state: "verifying" }));
  const model = createBatchModel({ api, targetId: batchId(2), maxPolls: 2 });
  await model.open(batchId(1));
  await vi.advanceTimersByTimeAsync(6000);
  expect(api.get).toHaveBeenCalledTimes(3);
  expect(model.getSnapshot().pollingPaused).toBe(true);
  expect(model.getSnapshot().batch?.state).toBe("verifying");
  await model.refresh();
  expect(api.get).toHaveBeenCalledTimes(4);
  model.close();
});
it("修改集号后的较晚旧GET不能覆盖新映射，关闭后的请求也不能回写", async () => {
  const api = apiFixture();
  const late = deferred<ReturnType<typeof batchFixture>>();
  const model = createBatchModel({ api, targetId: batchId(2) });
  await model.open(batchId(1));
  vi.mocked(api.get).mockReturnValueOnce(late.promise);
  const old = model.refresh();
  const changed = batchFixture();
  changed.items[0]!.episodeNo = 2;
  vi.mocked(api.update).mockResolvedValue(changed);
  await model.update(changed.items[0]!.uploadBatchItemId, { episodeNo: 2 });
  late.resolve(batchFixture());
  await old;
  expect(model.getSnapshot().batch?.items[0]?.episodeNo).toBe(2);
  const closed = deferred<ReturnType<typeof batchFixture>>();
  vi.mocked(api.get).mockReturnValueOnce(closed.promise);
  const pending = model.refresh();
  model.close();
  closed.resolve(batchFixture());
  await pending;
  expect(model.getSnapshot().batch?.items[0]?.episodeNo).toBe(2);
});
it("网络重试保留一次意图key、同步阻止双击，改内容换key，错误批次不接受", async () => {
  const api = apiFixture();
  const pending = deferred<ReturnType<typeof batchFixture>>();
  vi.mocked(api.create)
    .mockReturnValueOnce(pending.promise)
    .mockRejectedValueOnce(new Error("网络失败"));
  const model = createBatchModel({ api, targetId: batchId(2) });
  const body = {
    purpose: "final_release" as const,
    targetId: batchId(2),
    scope: "full" as const,
    isContentChanged: false,
    aiUsage: { used: false, tools: [] },
    files: [{ clientToken: "a", originalName: "a.mp4", sizeBytes: "1" }],
  };
  const first = model.create(body);
  await model.create(body);
  expect(api.create).toHaveBeenCalledTimes(1);
  pending.resolve(batchFixture());
  await first;
  await model.create(body);
  const retryKey = vi.mocked(api.create).mock.calls[1]![1];
  await model.create(body);
  expect(vi.mocked(api.create).mock.calls[2]![1]).toBe(retryKey);
  await model.create({ ...body, scope: "partial" });
  expect(vi.mocked(api.create).mock.calls[3]![1]).not.toBe(retryKey);
  vi.mocked(api.get).mockResolvedValueOnce(batchFixture({ targetId: batchId(99) }));
  await model.open(batchId(99));
  expect(model.getSnapshot().error).toContain("不属于");
  model.close();
});
