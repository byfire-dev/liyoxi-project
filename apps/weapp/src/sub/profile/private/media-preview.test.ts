import { describe, expect, it, vi } from "vitest";
import {
  createMediaPreview,
  createPreviewDownloader,
  mediaPreviewView,
  PREVIEW_FAILURE,
  type PreviewDownloadResult,
} from "./media-preview";

function deferred() {
  let resolve!: (value: PreviewDownloadResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<PreviewDownloadResult>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject, abort: vi.fn() };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const signed =
  "http://192.0.2.10:9110/asset/photo.jpg?X-Amz-Signature=fake&response-content-disposition=inline";
const image = (src: string, fileId = "photo") => ({ fileId, src });
function harness() {
  let context = "store-a|1";
  const tasks: ReturnType<typeof deferred>[] = [];
  const download = vi.fn((_url: string) => {
    const task = deferred();
    tasks.push(task);
    return task;
  });
  const preview = createMediaPreview({ context: () => context, download });
  return {
    preview,
    download,
    tasks,
    view: (images: Parameters<typeof preview.setImages>[0]) =>
      mediaPreviewView(preview.snapshot(), images, context),
    change(next: string) {
      context = next;
      preview.reset();
    },
  };
}

describe("档案图片临时文件预览", () => {
  it("本地/data图片首帧直接显示，不需要下载；空值不形成任务", () => {
    const h = harness();
    const images = [
      image("wxfile://tmp/chosen.jpg"),
      image("data:image/png;base64,fake", "inline"),
      image("blob:https://offline.invalid/picture", "blob"),
      { fileId: "empty", src: null },
    ];
    expect(h.view(images)).toEqual({
      sources: {
        photo: "wxfile://tmp/chosen.jpg",
        inline: "data:image/png;base64,fake",
        blob: "blob:https://offline.invalid/picture",
      },
      pending: false,
      message: null,
    });
    h.preview.setImages(images);
    expect(h.download).not.toHaveBeenCalled();
  });

  it.each([signed, signed.replace("http:", "https:")])(
    "远端完整地址原样下载，只显示200响应的本地路径：%s",
    async (src) => {
      const h = harness();
      const images = [image(src)];
      h.preview.setImages(images);
      expect(h.download).toHaveBeenCalledWith(src);
      expect(h.view(images)).toEqual({ sources: {}, pending: true, message: null });
      h.tasks[0]!.resolve({ statusCode: 200, tempFilePath: "wxfile://tmp/downloaded.jpg" });
      await flush();
      expect(h.view(images)).toEqual({
        sources: { photo: "wxfile://tmp/downloaded.jpg" },
        pending: false,
        message: null,
      });
      h.preview.setImages([{ ...images[0]! }]);
      expect(h.download).toHaveBeenCalledTimes(1);
    },
  );

  it("effect尚未重置上下文时，本地/data路径也不闪现到另一门店", () => {
    const h = harness();
    const images = [
      image("wxfile://tmp/old-store.jpg"),
      image("data:image/png;base64,old", "data"),
    ];
    h.preview.setImages(images);
    expect(mediaPreviewView(h.preview.snapshot(), images, "store-b|2")).toEqual({
      sources: {},
      pending: true,
      message: null,
    });
    expect(h.view(images).sources).toEqual({
      photo: "wxfile://tmp/old-store.jpg",
      data: "data:image/png;base64,old",
    });
  });

  it("同fileId签名更新立即隐藏旧路径；旧下载迟到不会替换新地址", async () => {
    const h = harness();
    const first = [image(signed)];
    h.preview.setImages(first);
    const fresh = [image(`${signed}&fresh=1`)];
    expect(h.view(fresh)).toEqual({ sources: {}, pending: true, message: null });
    h.preview.setImages(fresh);
    expect(h.tasks[0]!.abort).toHaveBeenCalledOnce();
    h.tasks[1]!.resolve({ statusCode: 200, tempFilePath: "wxfile://tmp/fresh.jpg" });
    await flush();
    h.tasks[0]!.resolve({ statusCode: 200, tempFilePath: "wxfile://tmp/stale.jpg" });
    await flush();
    expect(h.view(fresh).sources).toEqual({ photo: "wxfile://tmp/fresh.jpg" });
    expect(h.download).toHaveBeenCalledTimes(2);
  });

  it("已完成URL更新也重新下载；图片移除释放生命周期缓存", async () => {
    const h = harness();
    h.preview.setImages([image(signed)]);
    h.tasks[0]!.resolve({ statusCode: 200, tempFilePath: "wxfile://tmp/first.jpg" });
    await flush();
    h.preview.setImages([image(`${signed}&renewed=1`)]);
    expect(h.view([image(`${signed}&renewed=1`)])).toEqual({
      sources: {},
      pending: true,
      message: null,
    });
    h.preview.setImages([]);
    expect(h.preview.snapshot().images).toEqual({});
    expect(h.tasks[1]!.abort).toHaveBeenCalledOnce();
    h.preview.setImages([image(signed)]);
    expect(h.download).toHaveBeenCalledTimes(3);
  });

  it.each(["store-b|2", "logged-out|2"])(
    "上下文变为%s时清空；同fileId迟到结果和错误都不显示",
    async (next) => {
      const h = harness();
      const images = [image(signed)];
      h.preview.setImages(images);
      h.change(next);
      expect(h.view(images)).toEqual({ sources: {}, pending: true, message: null });
      h.preview.setImages(images);
      h.tasks[1]!.resolve({ statusCode: 200, tempFilePath: "wxfile://tmp/current.jpg" });
      await flush();
      h.tasks[0]!.reject(new Error(`native error ${signed}`));
      await flush();
      expect(h.view(images)).toEqual({
        sources: { photo: "wxfile://tmp/current.jpg" },
        pending: false,
        message: null,
      });
    },
  );

  it.each([
    { statusCode: 403, tempFilePath: "wxfile://tmp/forbidden.jpg" },
    { statusCode: 200 },
    { statusCode: 200, tempFilePath: " " },
  ])("拒绝不完整/非200成功回包，不显示签名地址：%j", async (result) => {
    const h = harness();
    const images = [image(signed)];
    h.preview.setImages(images);
    h.tasks[0]!.resolve(result);
    await flush();
    expect(h.view(images)).toEqual({ sources: {}, pending: false, message: PREVIEW_FAILURE });
    expect(h.view(images).message).not.toContain("Signature");
  });

  it("端口异常信息含签名时只给通用提示；页面卸载不公布迟到结果", async () => {
    const h = harness();
    const images = [image(signed)];
    h.preview.setImages(images);
    h.tasks[0]!.reject(new Error(`downloadFile failed: ${signed}`));
    await flush();
    expect(h.view(images).message).toBe(PREVIEW_FAILURE);
    h.preview.setImages([image(`${signed}&retry=1`)]);
    const listener = vi.fn();
    h.preview.subscribe(listener);
    h.preview.dispose();
    expect(h.preview.snapshot().images).toEqual({});
    h.tasks[1]!.resolve({ statusCode: 200, tempFilePath: "wxfile://tmp/closed.jpg" });
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(h.tasks[1]!.abort).toHaveBeenCalledOnce();
    h.preview.setImages(images);
    expect(h.download).toHaveBeenCalledTimes(2);
  });

  it("失败只通过显式重试再下载；不自动循环，也不重下已成功图片", async () => {
    const h = harness();
    const images = [image(signed), image(`${signed}&other=1`, "other")];
    h.preview.setImages(images);
    h.tasks[0]!.reject(new Error("offline"));
    h.tasks[1]!.resolve({ statusCode: 200, tempFilePath: "wxfile://tmp/other.jpg" });
    await flush();
    h.preview.setImages([...images]);
    expect(h.download).toHaveBeenCalledTimes(2);
    h.preview.retry();
    expect(h.download).toHaveBeenCalledTimes(3);
    expect(h.view(images)).toEqual({
      sources: { other: "wxfile://tmp/other.jpg" },
      pending: true,
      message: null,
    });
    h.preview.retry();
    expect(h.download).toHaveBeenCalledTimes(3);
    h.tasks[2]!.resolve({ statusCode: 200, tempFilePath: "wxfile://tmp/retried.jpg" });
    await flush();
    expect(h.view(images).sources).toEqual({
      photo: "wxfile://tmp/retried.jpg",
      other: "wxfile://tmp/other.jpg",
    });
  });
});

describe("档案图片下载并发", () => {
  it("多个页面控制器48张图共用最多3个活动下载，结束后继续队列", async () => {
    const tasks: ReturnType<typeof deferred>[] = [];
    let active = 0;
    let maximum = 0;
    const port = vi.fn((_url: string) => {
      const task = deferred();
      tasks.push(task);
      active++;
      maximum = Math.max(maximum, active);
      void task.promise.then(() => active--);
      return task;
    });
    const download = createPreviewDownloader(port);
    const previews = [0, 1, 2, 3].map(() =>
      createMediaPreview({ context: () => "store-a", download }),
    );
    previews.forEach((preview, group) =>
      preview.setImages(
        Array.from({ length: 12 }, (_, i) => image(`${signed}&photo=${group * 12 + i}`, `${i}`)),
      ),
    );
    expect(port).toHaveBeenCalledTimes(3);
    for (let index = 0; index < 48; index++) {
      tasks[index]!.resolve({ statusCode: 200, tempFilePath: `wxfile://tmp/${index}.jpg` });
      await flush();
    }
    expect(port).toHaveBeenCalledTimes(48);
    expect(maximum).toBe(3);
    expect(active).toBe(0);
    expect(previews.flatMap((preview) => Object.values(preview.snapshot().images))).toHaveLength(
      48,
    );
    expect(
      previews.every((preview) =>
        Object.values(preview.snapshot().images).every((entry) => entry.state === "ready"),
      ),
    ).toBe(true);
  });

  it("移除排队图片不下载；取消活动任务释放槽位，旧回调不能重复释放", async () => {
    const tasks: ReturnType<typeof deferred>[] = [];
    const port = vi.fn((_url: string) => {
      const task = deferred();
      tasks.push(task);
      return task;
    });
    const preview = createMediaPreview({
      context: () => "store-a",
      download: createPreviewDownloader(port, 1),
    });
    preview.setImages([image(`${signed}&a=1`, "a"), image(`${signed}&b=1`, "b")]);
    preview.setImages([image(`${signed}&a=1`, "a")]);
    preview.setImages([image(`${signed}&c=1`, "c"), image(`${signed}&d=1`, "d")]);
    expect(tasks[0]!.abort).toHaveBeenCalledOnce();
    expect(port).toHaveBeenCalledTimes(2);
    expect(port).not.toHaveBeenCalledWith(`${signed}&b=1`);
    tasks[0]!.resolve({ statusCode: 200, tempFilePath: "wxfile://tmp/removed.jpg" });
    await flush();
    expect(port).toHaveBeenCalledTimes(2);
    tasks[1]!.resolve({ statusCode: 200, tempFilePath: "wxfile://tmp/c.jpg" });
    await flush();
    expect(port).toHaveBeenCalledTimes(3);
    preview.dispose();
    await flush();
  });
});
