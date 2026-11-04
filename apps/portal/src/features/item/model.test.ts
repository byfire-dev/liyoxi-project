import { expect, it, vi } from "vitest";
import { createPortalRuntime } from "../../lib/runtime";
import { deferred, ok, SESSION } from "../../lib/api.test-helpers";
import { PortalApiError } from "../../lib/api-errors";
import type { DownloadResult, ItemApi } from "./api";
import { createItemModel } from "./model";
import { ITEM_ID, PUBLISH_LIST, RELEASE, result } from "./test-helpers";

async function harness() {
  const runtime = createPortalRuntime({
    fetch: vi.fn<typeof fetch>().mockImplementation(async () => ok(SESSION)),
  });
  await runtime.session.load();
  const api: ItemApi = {
    release: vi.fn().mockResolvedValue(RELEASE),
    publishList: vi.fn().mockResolvedValue(PUBLISH_LIST),
    download: vi.fn().mockResolvedValue(result()),
  };
  const effects = {
    now: () => Date.parse("2026-11-04T00:00:00.000Z"),
    saveDownload: vi.fn(),
    saveText: vi.fn(),
    copyText: vi.fn().mockResolvedValue(undefined),
  };
  const model = createItemModel(api, runtime.session, ITEM_ID, effects);
  await model.load();
  return {
    runtime,
    api,
    effects,
    model,
    close: () => {
      model.stop();
      runtime.dispose();
    },
  };
}
it("读取仅GET；每次单集点击现签且只表示已获地址，不缓存签名URL", async () => {
  const h = await harness();
  expect(h.api.download).not.toHaveBeenCalled();
  await h.model.episode(1);
  await h.model.episode(1);
  expect(h.api.download).toHaveBeenCalledTimes(2);
  expect(h.api.download).toHaveBeenCalledWith(
    ITEM_ID,
    { kind: "episode", episodeNo: 1 },
    expect.any(AbortSignal),
  );
  expect(h.effects.saveDownload).toHaveBeenCalledTimes(2);
  expect(h.model.getSnapshot().notice).toContain("已获取下载地址");
  expect(JSON.stringify(h.model.getSnapshot())).not.toContain("sign=transient");
  h.close();
});
it("禁止下载和跨店404保持阻断，不签发地址", async () => {
  const h = await harness();
  vi.mocked(h.api.release).mockResolvedValue({
    ...RELEASE,
    isDownloadable: false,
    downloadBlocker: { kind: "grant_invalid", reason: "expired" },
  });
  await h.model.load();
  await h.model.episode(1);
  await h.model.zip();
  await h.model.publishText(true);
  expect(h.api.download).not.toHaveBeenCalled();
  const other = createItemModel(
    { ...h.api, release: vi.fn().mockRejectedValue(new PortalApiError("NOT_FOUND", 404)) },
    h.runtime.session,
    "foreign",
    h.effects,
  );
  await other.load();
  await other.episode(1);
  expect(other.getSnapshot().release).toBeNull();
  expect(other.getSnapshot().error).not.toBe("");
  expect(h.effects.saveDownload).not.toHaveBeenCalled();
  other.stop();
  h.close();
});
it("会话失效后签发迟到结果不下载、不改通知", async () => {
  const h = await harness();
  const pending = deferred<DownloadResult>();
  vi.mocked(h.api.download).mockReturnValueOnce(pending.promise);
  const work = h.model.episode(1);
  h.runtime.session.invalidate();
  pending.resolve(result());
  await work;
  expect(h.effects.saveDownload).not.toHaveBeenCalled();
  expect(h.model.getSnapshot().notice).toBe("");
  expect(vi.mocked(h.api.download).mock.calls[0]![2].aborted).toBe(true);
  h.close();
});
it("ZIP失败不自动重试，显式重试才传retry true", async () => {
  const h = await harness();
  vi.mocked(h.api.download)
    .mockResolvedValueOnce(result("zip", "failed"))
    .mockResolvedValueOnce(result("zip"));
  await h.model.zip();
  expect(h.model.getSnapshot().zip).toBe("failed");
  expect(h.api.download).toHaveBeenCalledTimes(1);
  await h.model.zip(true);
  expect(h.api.download).toHaveBeenLastCalledWith(
    ITEM_ID,
    { kind: "zip", retry: true },
    expect.any(AbortSignal),
  );
  expect(h.model.getSnapshot().zip).toBe("ready");
  h.close();
});
it.each(["none", "building", "failed"] as const)(
  "清单%s用真实文本退路，不调用ZIP生成",
  async (state) => {
    const h = await harness();
    vi.mocked(h.api.download).mockResolvedValue(result("publish_list", state));
    await h.model.publishText(true);
    expect(h.api.download).toHaveBeenCalledTimes(1);
    expect(h.api.download).toHaveBeenCalledWith(
      ITEM_ID,
      { kind: "publish_list" },
      expect.any(AbortSignal),
    );
    expect(h.effects.saveText).toHaveBeenCalledWith(PUBLISH_LIST.text, "巷口那家店_发布清单.txt");
    expect(h.effects.saveDownload).not.toHaveBeenCalled();
    h.close();
  },
);
it("清单复制只取服务端文本；跨包文本不复制或生成文件", async () => {
  const h = await harness();
  await h.model.publishText(false);
  expect(h.effects.copyText).toHaveBeenCalledWith(PUBLISH_LIST.text);
  expect(h.api.download).not.toHaveBeenCalled();
  vi.mocked(h.api.publishList).mockResolvedValue({ ...PUBLISH_LIST, releaseNo: 1 });
  await h.model.publishText(false);
  expect(h.effects.copyText).toHaveBeenCalledTimes(1);
  expect(h.model.getSnapshot().actionError).not.toBe("");
  h.close();
});
