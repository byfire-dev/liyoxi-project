import { describe, it, expect, vi } from "vitest";
import { saveVideoUrl, type VideoAlbumBoundary } from "./platform";
describe("单次视频相册保存", () => {
  const boundary = () =>
    ({
      download: vi.fn(async () => ({ statusCode: 200, tempFilePath: "tmp/video" })),
      save: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    }) satisfies VideoAlbumBoundary;
  it("先下载再保存，传临时路径且不指定落盘路径", async () => {
    const b = boundary();
    const calls: string[] = [];
    b.download.mockImplementation(async () => {
      calls.push("download");
      return { statusCode: 200, tempFilePath: "tmp/video" };
    });
    b.save.mockImplementation(async () => {
      calls.push("save");
    });
    b.unlink.mockImplementation(async () => {
      calls.push("unlink");
    });
    await saveVideoUrl("https://signed.test/video", b);
    expect(calls).toEqual(["download", "save", "unlink"]);
    expect(b.download).toHaveBeenCalledWith("https://signed.test/video");
    expect(b.save).toHaveBeenCalledWith("tmp/video");
  });
  it("保存拒绝仍删临时文件，并保留失败给业务页", async () => {
    const b = boundary();
    b.save.mockRejectedValue(new Error("album denied"));
    b.unlink.mockRejectedValue(new Error("unlink failed"));
    await expect(saveVideoUrl("url", b)).rejects.toThrow("album denied");
    expect(b.unlink).toHaveBeenCalledOnce();
  });
  it("非200与空路径不会存入相册", async () => {
    const b = boundary();
    b.download.mockResolvedValue({ statusCode: 403, tempFilePath: "tmp/error" });
    await expect(saveVideoUrl("url", b)).rejects.toThrow("下载失败");
    expect(b.save).not.toHaveBeenCalled();
    expect(b.unlink).toHaveBeenCalledWith("tmp/error");
    b.download.mockResolvedValue({ statusCode: 200, tempFilePath: "" });
    await expect(saveVideoUrl("url", b)).rejects.toThrow("下载失败");
    expect(b.unlink).toHaveBeenCalledTimes(1);
  });
});
