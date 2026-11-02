import { beforeEach, describe, expect, it, vi } from "vitest";

import { createNativeImageRequester } from "./image-request.taro";

const native = vi.hoisted(() => ({
  request: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
}));
vi.mock("@tarojs/taro", () => ({
  default: {
    env: { USER_DATA_PATH: "wxfile://usr" },
    request: native.request,
    getFileSystemManager: () => ({
      writeFileSync: native.write,
      unlinkSync: native.remove,
      readdirSync: native.list,
    }),
  },
}));
const source = "http://192.0.2.10:9110/pub/cover.jpg?X-Amz-Signature=fake%2Bsignature";
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]).buffer;
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;
function respond(statusCode: number, data: ArrayBuffer) {
  const task = Object.assign(Promise.resolve({ statusCode, data }), { abort: vi.fn() });
  native.request.mockReturnValueOnce(task);
  return task;
}
beforeEach(() => {
  native.request.mockReset();
  native.write.mockReset();
  native.remove.mockReset();
  native.list.mockReset().mockReturnValue([]);
});

describe("封面原生临时图片恢复边界", () => {
  it("首次恢复只回收旧自有文件，下一张封面不删除当前进程正在使用的文件", async () => {
    vi.resetModules();
    const { createNativeImageRequester: createFreshRequester } =
      await import("./image-request.taro");
    const oldJpeg = "cover-00000000-0000-4000-8000-000000000001.jpg";
    const oldPng = "cover-00000000-0000-4000-8000-000000000002.png";
    native.list.mockReturnValue([
      oldJpeg,
      oldPng,
      "home-banner-other.png",
      "cover-not-owned.jpg",
      "notes.txt",
    ]);
    native.remove.mockImplementationOnce(() => {
      throw new Error("old file unavailable");
    });
    respond(200, jpeg);
    const first = createFreshRequester();
    const firstResult = await first.download(source).promise;
    expect(native.remove.mock.calls).toEqual([
      [`wxfile://usr/${oldJpeg}`],
      [`wxfile://usr/${oldPng}`],
    ]);
    native.list.mockReturnValue([firstResult.tempFilePath!.split("/").pop()]);
    respond(200, png);
    const second = createFreshRequester();
    const secondResult = await second.download(source).promise;
    expect(native.list).toHaveBeenCalledTimes(1);
    expect(native.remove).toHaveBeenCalledTimes(2);
    first.dispose();
    expect(native.remove).toHaveBeenLastCalledWith(firstResult.tempFilePath);
    second.dispose();
    expect(native.remove).toHaveBeenLastCalledWith(secondResult.tempFilePath);
  });
  it.each([
    [jpeg, "jpg"],
    [png, "png"],
  ] as const)("原签名URL按二进制请求，仅写自有%s图片，卸载清理", async (data, extension) => {
    respond(200, data);
    const requester = createNativeImageRequester();
    const result = await requester.download(source).promise;
    expect(native.request).toHaveBeenCalledExactlyOnceWith({
      url: source,
      method: "GET",
      dataType: "text",
      responseType: "arraybuffer",
      timeout: 15_000,
    });
    expect(result.statusCode).toBe(200);
    expect(result.tempFilePath).toMatch(
      new RegExp(`^wxfile://usr/cover-[a-f0-9-]+\\.${extension}$`),
    );
    expect(native.write).toHaveBeenCalledExactlyOnceWith(result.tempFilePath, data);
    expect(native.remove).not.toHaveBeenCalled();
    requester.dispose();
    requester.dispose();
    expect(native.remove).toHaveBeenCalledExactlyOnceWith(result.tempFilePath);
  });

  it("403不写入或提供本地图片", async () => {
    respond(403, jpeg);
    const requester = createNativeImageRequester();
    await expect(requester.download(source).promise).resolves.toEqual({ statusCode: 403 });
    expect(native.write).not.toHaveBeenCalled();
    requester.dispose();
    expect(native.remove).not.toHaveBeenCalled();
  });

  it.each([
    [new TextEncoder().encode("<html>not an image</html>").buffer, "not PNG or JPEG"],
    [new ArrayBuffer(5 * 1024 * 1024 + 1), "exceeds upload limit"],
  ] as const)("拒绝200非图片或超出原上传上限的正文", async (data, reason) => {
    respond(200, data);
    const requester = createNativeImageRequester();
    await expect(requester.download(source).promise).rejects.toThrow(reason);
    expect(native.write).not.toHaveBeenCalled();
    requester.dispose();
  });

  it("写入失败时清理可能产生的自有残片", async () => {
    respond(200, jpeg);
    native.write.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const requester = createNativeImageRequester();
    await expect(requester.download(source).promise).rejects.toThrow("disk full");
    const path = native.write.mock.calls[0]?.[0];
    expect(native.remove).toHaveBeenCalledExactlyOnceWith(path);
    requester.dispose();
    expect(native.remove).toHaveBeenCalledTimes(1);
  });
});
