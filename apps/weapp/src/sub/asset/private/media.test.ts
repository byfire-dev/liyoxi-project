import { describe, expect, it, vi } from "vitest";
import { assetDetail } from "../../../../shots/asset-fixtures";
import type { AssetDetail } from "./api";
import { createAssetMedia, fileAvailable, type AssetMediaPorts } from "./media";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(kind: "image" | "video" | "audio" | "document" = "image") {
  let detail: AssetDetail | null = assetDetail(kind),
    scope: string | null = "owner/store",
    now = 1000;
  detail.files = detail.files.map((file, n) => ({
    ...file,
    url: `https://signed.invalid/${n}`,
    expiresAt: new Date(2000).toISOString(),
  }));
  let ended = () => {},
    failed = () => {};
  const audio = {
    src: "",
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(),
    onError: (run: () => void) => {
      failed = run;
    },
    onEnded: (run: () => void) => {
      ended = run;
    },
  };
  const abort = vi.fn();
  const ports = {
    privacy: vi.fn<AssetMediaPorts["privacy"]>().mockResolvedValue(true),
    image: vi.fn<AssetMediaPorts["image"]>().mockResolvedValue(undefined),
    video: vi.fn<AssetMediaPorts["video"]>(),
    stopVideo: vi.fn(),
    download: vi.fn<AssetMediaPorts["download"]>().mockReturnValue({
      promise: Promise.resolve({ statusCode: 200, tempFilePath: "/temp/document" }),
      abort,
    }),
    document: vi.fn<AssetMediaPorts["document"]>().mockResolvedValue(undefined),
    unlink: vi.fn(),
    audio: vi.fn<AssetMediaPorts["audio"]>().mockReturnValue(audio),
  };
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    publish = vi.fn();
  const media = createAssetMedia({
    ports,
    scope: () => scope,
    detail: () => detail,
    refresh,
    now: () => now,
    publish,
  });
  return {
    media,
    ports,
    audio,
    abort,
    refresh,
    publish,
    id: detail.files[0]!.fileId,
    detail: () => detail!,
    setDetail: (value: AssetDetail | null) => {
      detail = value;
    },
    scope: (value: string | null) => {
      scope = value;
    },
    now: (value: number) => {
      now = value;
    },
    ended: () => ended(),
    failed: () => failed(),
  };
}
describe("素材原生预览生命周期", () => {
  it("图片仅打开当前有签名且未过期的完整图片集合", async () => {
    const h = setup();
    h.detail().files[1]!.expiresAt = new Date(500).toISOString();
    await h.media.open(h.id);
    expect(h.ports.privacy).toHaveBeenCalledTimes(1);
    expect(h.ports.image).toHaveBeenCalledExactlyOnceWith(
      ["https://signed.invalid/0"],
      "https://signed.invalid/0",
    );
    expect(h.refresh).not.toHaveBeenCalled();
  });
  it.each(["declined", "scope", "dispose"])("授权返回前 %s 不预览不下载", async (mode) => {
    const h = setup(),
      privacy = deferred<boolean>();
    h.ports.privacy.mockReturnValueOnce(privacy.promise);
    const pending = h.media.open(h.id);
    if (mode === "scope") h.scope("clerk/store");
    if (mode === "dispose") h.media.dispose();
    privacy.resolve(mode !== "declined");
    await pending;
    expect(h.ports.image).not.toHaveBeenCalled();
    expect(h.ports.download).not.toHaveBeenCalled();
    expect(h.ports.audio).not.toHaveBeenCalled();
  });
  it.each(["expired", "null", "explicit"])(
    "%s 仅一次重取当前详情并按同fileId找新签名",
    async (mode) => {
      const h = setup();
      if (mode === "expired") h.now(3000);
      if (mode === "null") h.detail().files[0]!.url = null;
      h.refresh.mockImplementationOnce(async () => {
        h.detail().files[0] = {
          ...h.detail().files[0]!,
          url: "https://signed.invalid/new",
          expiresAt: new Date(4000).toISOString(),
        };
      });
      await h.media.open(h.id, mode === "explicit");
      expect(h.refresh).toHaveBeenCalledTimes(1);
      expect(h.ports.image).toHaveBeenCalledWith(
        expect.arrayContaining(["https://signed.invalid/new"]),
        "https://signed.invalid/new",
      );
    },
  );
  it("刷新仍无签名不循环请求，错误只给安全重试文案", async () => {
    const h = setup();
    h.detail().files[0]!.url = null;
    await h.media.open(h.id);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.ports.image).not.toHaveBeenCalled();
    expect(h.publish.mock.calls.at(-1)?.[0]).toBe("文件暂时无法预览，请重新获取后重试");
  });
  it.each(["scope", "asset", "file"])("重取期间 %s 改变不打开旧文件", async (mode) => {
    const h = setup(),
      refresh = deferred<void>();
    h.detail().files[0]!.url = null;
    h.refresh.mockReturnValueOnce(refresh.promise);
    const pending = h.media.open(h.id);
    await Promise.resolve();
    if (mode === "scope") h.scope(null);
    if (mode === "asset") h.setDetail({ ...h.detail(), storeAssetId: "new" });
    if (mode === "file") h.detail().files = [];
    refresh.resolve();
    await pending;
    expect(h.ports.image).not.toHaveBeenCalled();
  });
  it("文档真实download→openDocument，完成后清理临时文件且不猜fileType", async () => {
    const h = setup("document");
    await h.media.open(h.id);
    expect(h.ports.download).toHaveBeenCalledExactlyOnceWith("https://signed.invalid/0");
    expect(h.ports.document).toHaveBeenCalledExactlyOnceWith("/temp/document");
    expect(h.ports.unlink).toHaveBeenCalledExactlyOnceWith("/temp/document");
  });
  it.each(["hide", "scope", "source", "expired"])("下载迟到 %s 不open且清理temp", async (mode) => {
    const h = setup("document"),
      download = deferred<{ statusCode: number; tempFilePath: string }>();
    h.ports.download.mockReturnValueOnce({ promise: download.promise, abort: h.abort });
    const pending = h.media.open(h.id);
    await Promise.resolve();
    if (mode === "hide") h.media.stop();
    if (mode === "scope") h.scope("other");
    if (mode === "source") h.detail().files[0]!.url = "new";
    if (mode === "expired") h.now(3000);
    download.resolve({ statusCode: 200, tempFilePath: "/temp/late" });
    await pending;
    expect(h.ports.document).not.toHaveBeenCalled();
    expect(h.ports.unlink).toHaveBeenCalledWith("/temp/late");
    if (mode === "hide") expect(h.abort).toHaveBeenCalledTimes(1);
  });
  it.each(["http", "empty", "open"])("文档 %s 失败可重试且不回显原异常", async (mode) => {
    const h = setup("document");
    if (mode === "open") h.ports.document.mockRejectedValueOnce(new Error("secret-signed-url"));
    else
      h.ports.download.mockReturnValueOnce({
        promise: Promise.resolve({
          statusCode: mode === "http" ? 403 : 200,
          tempFilePath: mode === "empty" ? "" : "/temp/failed",
        }),
        abort: h.abort,
      });
    await h.media.open(h.id);
    expect(h.publish.mock.calls.at(-1)?.[0]).not.toContain("secret");
    expect(h.publish.mock.calls.at(-1)?.[0]).toContain("重试");
    await h.media.open(h.id);
    expect(h.ports.download).toHaveBeenCalledTimes(2);
  });
  it("音频用户播放／暂停、结束状态与销毁全部经过当前端口", async () => {
    const h = setup("audio");
    await h.media.open(h.id);
    expect(h.audio.src).toBe("https://signed.invalid/0");
    expect(h.audio.play).toHaveBeenCalledTimes(1);
    await h.media.open(h.id);
    expect(h.audio.pause).toHaveBeenCalledTimes(1);
    await h.media.open(h.id);
    h.ended();
    expect(h.publish).toHaveBeenLastCalledWith(null, null);
    h.media.dispose();
    expect(h.audio.stop).toHaveBeenCalled();
    expect(h.audio.destroy).toHaveBeenCalled();
  });
  it("音频旧错误不发布到新上下文，当前错误释放原生资源", async () => {
    const h = setup("audio");
    await h.media.open(h.id);
    const before = h.publish.mock.calls.length;
    h.scope("other");
    h.failed();
    expect(h.publish).toHaveBeenCalledTimes(before);
    const fresh = setup("audio");
    await fresh.media.open(fresh.id);
    fresh.failed();
    expect(fresh.audio.destroy).toHaveBeenCalled();
    expect(fresh.publish).toHaveBeenLastCalledWith("音频暂时无法播放，请重新获取文件", null);
  });
  it("视频只有显式授权后配置播放源，stop销毁当前展示", async () => {
    const h = setup("video");
    await h.media.open(h.id);
    expect(h.ports.video).toHaveBeenCalledExactlyOnceWith("https://signed.invalid/0", h.id);
    h.media.stop();
    expect(h.ports.stopVideo).toHaveBeenCalledTimes(2);
  });
  it("旧请求finally不清新下载，停页仍能abort当前实际task", async () => {
    const h = setup("document"),
      first = deferred<{ statusCode: number; tempFilePath: string }>(),
      second = deferred<{ statusCode: number; tempFilePath: string }>(),
      secondAbort = vi.fn();
    h.ports.download
      .mockReturnValueOnce({ promise: first.promise, abort: h.abort })
      .mockReturnValueOnce({ promise: second.promise, abort: secondAbort });
    const a = h.media.open(h.id);
    await Promise.resolve();
    const b = h.media.open(h.id);
    await Promise.resolve();
    first.resolve({ statusCode: 200, tempFilePath: "/temp/old" });
    await a;
    h.media.stop();
    expect(secondAbort).toHaveBeenCalledTimes(1);
    second.resolve({ statusCode: 200, tempFilePath: "/temp/new" });
    await b;
    expect(h.ports.document).not.toHaveBeenCalled();
    expect(h.ports.unlink).toHaveBeenCalledTimes(2);
  });
  it("可见性只判断当前真实签名期限；null与边界均不可用", () => {
    const h = setup();
    expect(fileAvailable(h.detail().files[0]!, 1000)).toBe(true);
    expect(fileAvailable(h.detail().files[0]!, 2000)).toBe(false);
    expect(fileAvailable({ ...h.detail().files[0]!, url: null }, 0)).toBe(false);
  });
});
