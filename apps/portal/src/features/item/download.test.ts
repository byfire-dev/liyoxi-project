import { afterEach, expect, it, vi } from "vitest";
import { PortalApiError } from "../../lib/api-errors";
import type { ItemApi } from "./api";
import { downloadHref, requestZip, ZIP_TIMEOUT_MS } from "./download";
import { result } from "./test-helpers";

afterEach(() => vi.useRealTimers());
const apiOf = (download: ItemApi["download"]): ItemApi => ({
  download,
  release: vi.fn(),
  publishList: vi.fn(),
});
it("building每5秒现签轮询，显式retry只传第一次，ready返回即停止", async () => {
  const download = vi
    .fn<ItemApi["download"]>()
    .mockResolvedValueOnce(result("zip", "building"))
    .mockResolvedValueOnce(result("zip"));
  const wait = vi.fn(async () => {});
  const received = await requestZip({
    api: apiOf(download),
    id: "item",
    signal: new AbortController().signal,
    retry: true,
    current: () => true,
    building: vi.fn(),
    now: () => 0,
    wait,
  });
  expect(received).toEqual(result("zip"));
  expect(download.mock.calls.map(([, body]) => body)).toEqual([
    { kind: "zip", retry: true },
    { kind: "zip", retry: false },
  ]);
  expect(wait).toHaveBeenCalledWith(5000, expect.any(AbortSignal));
});
it("failed不自动重试；10分钟停止building且不发第121次请求", async () => {
  const failed = vi.fn<ItemApi["download"]>().mockResolvedValue(result("zip", "failed"));
  const options = {
    id: "item",
    signal: new AbortController().signal,
    retry: false,
    current: () => true,
    building: vi.fn(),
  };
  expect(await requestZip({ ...options, api: apiOf(failed) })).toEqual(result("zip", "failed"));
  expect(failed).toHaveBeenCalledTimes(1);
  let now = 0;
  const download = vi.fn<ItemApi["download"]>().mockResolvedValue(result("zip", "building"));
  expect(
    await requestZip({
      ...options,
      api: apiOf(download),
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
    }),
  ).toBe("timeout");
  expect(now).toBe(ZIP_TIMEOUT_MS);
  expect(download).toHaveBeenCalledTimes(120);
});
it("十分钟也中断未返回请求，用户取消不再轮询", async () => {
  vi.useFakeTimers();
  const download = vi.fn<ItemApi["download"]>().mockImplementation(
    (_id, _body, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new PortalApiError("REQUEST_ABORTED")), {
          once: true,
        });
      }),
  );
  const controller = new AbortController();
  const options = {
    api: apiOf(download),
    id: "item",
    signal: controller.signal,
    retry: false,
    current: () => true,
    building: vi.fn(),
  };
  const timeout = requestZip(options);
  await vi.advanceTimersByTimeAsync(ZIP_TIMEOUT_MS);
  expect(await timeout).toBe("timeout");
  const pending = requestZip(options);
  const rejection = expect(pending).rejects.toMatchObject({ error: "REQUEST_ABORTED" });
  controller.abort();
  await rejection;
  expect(download).toHaveBeenCalledTimes(2);
});
it("下载地址拒绝脚本、嵌入凭据和非法地址", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,bad",
    "https://user:pass@example.invalid/file",
    "bad",
  ])
    expect(() => downloadHref(url)).toThrow(PortalApiError);
  expect(downloadHref("https://download.example.invalid/file?sign=temporary")).toContain(
    "https://download.example.invalid/",
  );
});
