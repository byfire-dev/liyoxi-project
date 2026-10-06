import { describe, expect, it, vi } from "vitest";
import { precheckFile, type PrecheckDeps } from "./precheck";
const MB = 1024 * 1024;
const file = { path: "source", name: "photo.png", size: 8 * MB, width: 800, height: 600 };
function harness(): PrecheckDeps {
  return {
    compress: vi.fn(async (original) => original),
    compressVideo: vi.fn(async (original) => original),
    network: vi.fn(async () => "wifi"),
    confirmCellular: vi.fn(async () => true),
  };
}
describe("端上文件体检", () => {
  it("按80/60/40逐档降质，最终摘要元数据来自压缩后文件，原选取数据不变", async () => {
    const deps = harness();
    vi.mocked(deps.compress)
      .mockRejectedValueOnce(new Error("平台不支持此档"))
      .mockResolvedValueOnce({ ...file, path: "60", size: 6 * MB })
      .mockResolvedValueOnce({
        ...file,
        name: "photo.jpg",
        path: "40",
        size: 3 * MB,
        width: 400,
        height: 300,
      });
    expect(
      await precheckFile(deps, file, "profile_image", { imageMaxMb: 4, weappVideoMaxMb: 100 }),
    ).toEqual({ ...file, name: "photo.jpg", path: "40", size: 3 * MB, width: 400, height: 300 });
    expect(vi.mocked(deps.compress).mock.calls.map((call) => call[1])).toEqual([80, 60, 40]);
    expect(file.path).toBe("source");
    expect(deps.network).not.toHaveBeenCalled();
  });
  it("视频超配置上限先压缩，仍超限给代传；不会改变服务端通道", async () => {
    const deps = harness(),
      video = { ...file, name: "clip.mp4", size: 90 * MB };
    vi.mocked(deps.compressVideo).mockResolvedValue({
      ...video,
      path: "compressed",
      size: 65 * MB,
    });
    await expect(
      precheckFile(deps, video, "profile_video", { imageMaxMb: 5, weappVideoMaxMb: 60 }),
    ).rejects.toThrow("服务经理代传");
    expect(deps.compressVideo).toHaveBeenCalledTimes(1);
  });
  it("蜂窝超过50MB必须确认，拒绝不进入上传队列；WiFi无需确认", async () => {
    const deps = harness(),
      video = { ...file, name: "clip.mp4", size: 60 * MB };
    vi.mocked(deps.network).mockResolvedValue("4g");
    vi.mocked(deps.confirmCellular).mockResolvedValue(false);
    expect(
      await precheckFile(deps, video, "profile_video", { imageMaxMb: 5, weappVideoMaxMb: 80 }),
    ).toBeNull();
    expect(deps.confirmCellular).toHaveBeenCalledWith(60);
    vi.mocked(deps.network).mockResolvedValue("wifi");
    expect(
      await precheckFile(deps, video, "profile_video", { imageMaxMb: 5, weappVideoMaxMb: 80 }),
    ).toEqual(video);
    expect(deps.confirmCellular).toHaveBeenCalledTimes(1);
  });
  it("分类类型闭合：图片分类拒绝视频，对公PDF保留登记API的权威上限", async () => {
    const deps = harness();
    await expect(
      precheckFile(deps, { ...file, name: "a.mp4" }, "kyc_license", {
        imageMaxMb: 5,
        weappVideoMaxMb: 100,
      }),
    ).rejects.toThrow("格式");
    expect(
      await precheckFile(deps, { ...file, name: "a.pdf" }, "pay_receipt", {
        imageMaxMb: 5,
        weappVideoMaxMb: 100,
      }),
    ).toEqual({ ...file, name: "a.pdf" });
    expect(
      await precheckFile(deps, { ...file, name: "a.pdf", size: 11 * MB }, "pay_receipt", {
        imageMaxMb: 5,
        weappVideoMaxMb: 100,
      }),
    ).toEqual({ ...file, name: "a.pdf", size: 11 * MB });
    expect(deps.compress).not.toHaveBeenCalled();
  });
});
