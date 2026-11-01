import { describe, expect, it, vi } from "vitest";
import { sample } from "../../../../shots/delivery-fixtures";
import type { Sample } from "../components/delivery-api";
import { createSampleFeedback, createFeedbackUpload, sampleFeedbackBody } from "./feedback";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function setup() {
  let view: Sample = { ...structuredClone(sample), actions: ["confirm", "request-change"] },
    scope = "store1",
    seq = 0;
  const changed = { ...view, status: "change_requested" as const, actions: [] };
  const api = {
    requestChange: vi.fn(async () => ({ ...changed, replayed: false })),
    sample: vi.fn(async (): Promise<Sample> => changed),
  };
  const replace = vi.fn();
  const model = createSampleFeedback({
    api,
    scope: () => scope,
    sample: () => view,
    enabled: () => true,
    key: () => `key-${++seq}`,
    itemId: sample.orderItemId,
    replace,
  });
  return {
    api,
    model,
    replace,
    get view() {
      return view;
    },
    next() {
      view = { ...view!, sampleId: "new-sample", versionNo: 3 };
    },
    switchScope() {
      scope = "store2";
    },
  };
}
describe("样片合成修改", () => {
  it("真实正文仅compose/note/imageFileIds；旧版/暂停/关停/未ready及截图数量重复拒绝", () => {
    const f = setup(),
      image = { fileId: "image1", src: "local" };
    expect(sampleFeedbackBody(f.view, "  字幕请上移  ", [image], true)).toEqual({
      feedbackKind: "compose",
      note: "字幕请上移",
      imageFileIds: ["image1"],
    });
    for (const view of [
      { ...f.view!, status: "superseded" as const },
      { ...f.view!, isPaused: true },
      { ...f.view!, playable: null },
      { ...f.view!, previewChannels: ["album"] as "album"[] },
    ])
      expect(() => sampleFeedbackBody(view, "字幕", [], true)).toThrow();
    expect(() => sampleFeedbackBody(f.view, "字幕", [], false)).toThrow();
    for (const files of [
      [image, image],
      Array.from({ length: 4 }, (_, i) => ({ ...image, fileId: String(i) })),
    ])
      expect(() => sampleFeedbackBody(f.view, "字幕", files, true)).toThrow();
    expect(() => sampleFeedbackBody(f.view, " ", [], true)).toThrow();
  });
  it("未知结果重试同key/同正文，重复点击单飞，成功后真实GET再替换", async () => {
    const f = setup();
    f.api.requestChange.mockRejectedValueOnce(new Error("未知结果"));
    await expect(f.model.submit("字幕上移", [], () => true)).rejects.toThrow("未知结果");
    const barrier = deferred<Awaited<ReturnType<typeof f.api.requestChange>>>();
    f.api.requestChange.mockImplementationOnce(() => barrier.promise);
    const pending = f.model.submit("字幕上移", [], () => true);
    expect(await f.model.submit("字幕上移", [], () => true)).toBe(false);
    barrier.resolve({ ...f.view!, status: "change_requested", actions: [], replayed: true });
    await pending;
    expect(f.api.requestChange.mock.calls[0]).toEqual(f.api.requestChange.mock.calls[1]);
    expect(f.api.requestChange.mock.calls[0]).toEqual([
      sample.sampleId,
      { feedbackKind: "compose", note: "字幕上移" },
      "key-1",
    ]);
    expect(f.api.sample).toHaveBeenCalledWith(sample.orderItemId);
    expect(f.replace).toHaveBeenCalledTimes(1);
  });
  it("写请求或后续GET迟到时，换版本/换店/卸载不回写，不拿旧草稿发新版本", async () => {
    for (const invalidate of ["version", "scope", "dispose"]) {
      const f = setup(),
        late = deferred<Awaited<ReturnType<typeof f.api.requestChange>>>();
      f.api.requestChange.mockImplementationOnce(() => late.promise);
      const pending = f.model.submit("字幕", [], () => true);
      if (invalidate === "version") f.next();
      else if (invalidate === "scope") f.switchScope();
      else f.model.dispose();
      late.resolve({ ...f.view!, status: "change_requested", actions: [], replayed: true });
      expect(await pending).toBe(false);
      expect(f.api.sample).not.toHaveBeenCalled();
      expect(f.replace).not.toHaveBeenCalled();
    }
    const f = setup(),
      read = deferred<NonNullable<Sample>>();
    f.api.sample.mockImplementationOnce(() => read.promise);
    const pending = f.model.submit("字幕", [], () => true);
    await Promise.resolve();
    f.next();
    read.resolve({ ...sample, status: "change_requested" });
    await pending;
    expect(f.replace).not.toHaveBeenCalled();
  });
  it("截图删除或版本卸载后的stored迟到结果丢弃；仅成功stored给fileId", async () => {
    const late = deferred<{ fileId: string } | null>(),
      stored = vi.fn();
    const job = {
      start: vi.fn(() => late.promise),
      retry: vi.fn(() => late.promise),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    const upload = createFeedbackUpload(job, () => true, stored),
      pending = upload.finish();
    await upload.remove();
    late.resolve({ fileId: "old-file" });
    await pending;
    expect(stored).not.toHaveBeenCalled();
    const next = createFeedbackUpload(
      { ...job, start: vi.fn(async () => ({ fileId: "stored-file" })) },
      () => true,
      stored,
    );
    await next.finish();
    await next.finish();
    expect(stored).toHaveBeenCalledExactlyOnceWith("stored-file");
  });
});
