import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DramaTrailerWriteResultSchema } from "@liyoxi/contract";
import { createAdminApi, type ApiHandlers } from "../../../lib/api";
import { createDramaApi } from "./api";

const dramaId = "00000000-0000-4000-8000-000000000001";
const sourceFileId = "00000000-0000-4000-8000-000000000002";
const key = "w312:trailer-checking";
const checked = DramaTrailerWriteResultSchema.parse({
  targetPlayableId: "00000000-0000-4000-8000-000000000003",
  currentPlayableId: null,
  state: "processing",
  sourceFile: {
    fileId: sourceFileId,
    originalName: "虚构预告片.mp4",
    sizeBytes: "1",
    mime: "video/mp4",
    status: "stored",
    moderationState: "pending",
  },
  durationMs: 20_000,
  width: 1080,
  height: 1920,
  coverUrl: null,
  error: null,
  setBy: {
    staffId: "00000000-0000-4000-8000-000000000004",
    staffNo: 1001,
    name: "虚构运营",
    roleKey: "ops",
    isLead: false,
    status: "active",
  },
  setAt: "2026-10-10T00:00:00.000Z",
  readyAt: null,
  replayed: false,
});
function failure(error = "TRAILER_SOURCE_CHECKING", retryable = true, status = 409) {
  return new Response(
    JSON.stringify({
      code: 49218,
      error,
      message: "源文件还在检测",
      retryable,
      requestId: "w312-checking",
      details: { sourceFileId },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}
function success() {
  return new Response(JSON.stringify({ code: 0, message: "ok", data: checked }), {
    headers: { "Content-Type": "application/json" },
  });
}
function api(fetch: (request: Request) => Promise<Response>) {
  const handlers: ApiHandlers = {
    redirectToLogin: vi.fn(),
    stepUp: vi.fn(async () => false),
    refreshAccess: vi.fn(),
    invalidateQueries: vi.fn(),
    notify: vi.fn(),
    showBlocked: vi.fn(),
    buildMismatch: vi.fn(),
  };
  return createDramaApi({
    api: createAdminApi({
      baseUrl: "https://fictional-admin.test",
      build: "w312",
      handlers,
      fetch,
    }),
  });
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("仅检查中自动重试：实际typed请求始终同body/key，成功清理deadline及caller监听", async () => {
  const requests: Request[] = [],
    bodies: unknown[] = [];
  const controller = new AbortController();
  const added = vi.spyOn(controller.signal, "addEventListener");
  const removed = vi.spyOn(controller.signal, "removeEventListener");
  const client = api(async (request) => {
    requests.push(request);
    bodies.push(await request.clone().json());
    return requests.length < 3 ? failure() : success();
  });
  const result = client.trailer(dramaId, sourceFileId, key, controller.signal);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await result).toEqual(checked);
  expect(requests).toHaveLength(3);
  expect(bodies).toEqual(Array.from({ length: 3 }, () => ({ sourceFileId })));
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual(
    Array.from({ length: 3 }, () => ["PUT", `/api/v1/admin/dramas/${dramaId}/trailer`]),
  );
  expect(requests.every((request) => request.headers.get("Idempotency-Key") === key)).toBe(true);
  const listener = added.mock.calls.find(([event]) => event === "abort")?.[1];
  expect(listener).toBeDefined();
  expect(removed).toHaveBeenCalledWith("abort", listener);
  expect(vi.getTimerCount()).toBe(0);
  controller.abort();
  expect(requests.every((request) => !request.signal.aborted)).toBe(true);
});

it("进入前已取消则零请求，清理已装配的计时与监听", async () => {
  const fetch = vi.fn(async (_request: Request) => success());
  const controller = new AbortController();
  controller.abort(new DOMException("已关闭", "AbortError"));
  await expect(
    api(fetch).trailer(dramaId, sourceFileId, key, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("检查中等待可被caller取消，没有下一次外呼或遗留timer", async () => {
  const fetch = vi.fn(async (_request: Request) => failure());
  const controller = new AbortController();
  const result = api(fetch).trailer(dramaId, sourceFileId, key, controller.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  controller.abort(new DOMException("已关闭", "AbortError"));
  await rejected;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

function pendingFetch(requests: Request[]) {
  return (request: Request) => {
    requests.push(request);
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(request.signal.reason);
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
    });
  };
}
it("正在请求也受caller取消，原Abort原因保持且不会重发", async () => {
  const requests: Request[] = [];
  const controller = new AbortController(),
    reason = new DOMException("已关闭请求", "AbortError");
  const result = api(pendingFetch(requests)).trailer(dramaId, sourceFileId, key, controller.signal);
  const rejected = expect(result).rejects.toBe(reason);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort(reason);
  await rejected;
  expect(requests).toHaveLength(1);
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("独立120秒deadline终止未返回请求，不依赖caller主动关闭", async () => {
  const requests: Request[] = [];
  const result = api(pendingFetch(requests)).trailer(dramaId, sourceFileId, key);
  const rejected = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
  await vi.advanceTimersByTimeAsync(120_000);
  await rejected;
  expect(requests).toHaveLength(1);
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("最多120次，耗尽保留真实CHECKING失败，不再延后外呼", async () => {
  const fetch = vi.fn(async (_request: Request) => failure());
  const result = api(fetch).trailer(dramaId, sourceFileId, key);
  const rejected = expect(result).rejects.toMatchObject({
    failure: { symbol: "TRAILER_SOURCE_CHECKING", body: { retryable: true } },
  });
  await vi.advanceTimersByTimeAsync(119_000);
  await rejected;
  expect(fetch).toHaveBeenCalledTimes(120);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fetch).toHaveBeenCalledTimes(120);
});

it.each([
  ["TRAILER_SOURCE_CHECKING", false],
  ["TRAILER_SOURCE_REJECTED", true],
  ["UNKNOWN_TRAILER_FAILURE", true],
] as const)("%s retryable=%s 立即失败，不能泛化吞掉拒绝或未知错误", async (symbol, retryable) => {
  const fetch = vi.fn(async (_request: Request) => failure(symbol, retryable));
  await expect(api(fetch).trailer(dramaId, sourceFileId, key)).rejects.toMatchObject({
    failure: { symbol },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("相同符号却不是正式409也立即失败，不把服务故障当体检等待", async () => {
  const fetch = vi.fn(async (_request: Request) => failure("TRAILER_SOURCE_CHECKING", true, 500));
  await expect(api(fetch).trailer(dramaId, sourceFileId, key)).rejects.toMatchObject({
    failure: { status: 500 },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("网络结果未知立即失败，不按检测中重发", async () => {
  const reason = new Error("网络结果未知");
  const fetch = vi.fn(async (_request: Request): Promise<Response> => {
    throw reason;
  });
  await expect(api(fetch).trailer(dramaId, sourceFileId, key)).rejects.toBe(reason);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
