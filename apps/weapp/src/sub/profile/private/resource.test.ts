import { describe, expect, it, vi } from "vitest";
import { createResource, resourceView } from "./resource";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function harness() {
  let context = "owner|store-a|1";
  const read = vi.fn<() => Promise<string | undefined>>();
  const resource = createResource({
    context: () => context,
    read,
    message: (error) => (error as Error).message,
  });
  return {
    resource,
    read,
    change(next: string) {
      context = next;
      resource.reset();
    },
  };
}

describe("建档资源刷新与内容生命周期", () => {
  it.each(["success", "failure"])("保存新视图后，旧GET的%s不覆盖保存结果", async (outcome) => {
    const { resource, read } = harness();
    const old = deferred<string>();
    read.mockReturnValueOnce(old.promise);
    const work = resource.load();
    resource.setData("saved-confirmation");
    expect(resource.snapshot()).toEqual({
      data: "saved-confirmation",
      loading: false,
      error: null,
    });
    if (outcome === "success") old.resolve("old-unconfirmed");
    else old.reject(new Error("旧读取失败"));
    await work;
    expect(resource.snapshot()).toEqual({
      data: "saved-confirmation",
      loading: false,
      error: null,
    });
    read.mockResolvedValueOnce("fresh-read");
    await resource.load();
    expect(resource.snapshot().data).toBe("fresh-read");
  });
  it("首次读取显示骨架；选择照片期间回前台刷新保持同一个内容实例", async () => {
    const { resource, read } = harness();
    const first = deferred<string>();
    read.mockReturnValueOnce(first.promise);
    const initial = resource.load();
    expect(resourceView(resource.snapshot())).toBe("loading");
    first.resolve("store-a");
    await initial;
    expect(resourceView(resource.snapshot())).toBe("content");

    const selection = deferred<string>();
    let mounted = true;
    resource.subscribe(() => {
      if (resourceView(resource.snapshot()) !== "content") mounted = false;
    });
    const selected = selection.promise.then((file) => (mounted ? file : null));
    const refresh = deferred<string>();
    read.mockReturnValueOnce(refresh.promise);
    const onShow = resource.load();
    expect(resource.snapshot().data).toBe("store-a");
    expect(resourceView(resource.snapshot())).toBe("content");
    selection.resolve("chosen-photo");
    expect(await selected).toBe("chosen-photo");
    refresh.resolve("store-a-refreshed");
    await onShow;
    expect(mounted).toBe(true);
  });

  it("刷新失败保留表单并提供非阻断错误，重试仍不卸载", async () => {
    const { resource, read } = harness();
    read.mockResolvedValueOnce("store-a");
    await resource.load();
    read.mockRejectedValueOnce(new Error("网络不可用"));
    await resource.load();
    expect(resource.snapshot().data).toBe("store-a");
    expect(resourceView(resource.snapshot())).toBe("content");
    expect(resource.snapshot().error).toEqual({ message: "网络不可用", preserveContent: true });
    const retry = deferred<string>();
    read.mockReturnValueOnce(retry.promise);
    const work = resource.load();
    expect(resourceView(resource.snapshot())).toBe("content");
    expect(resource.snapshot().error).toBeNull();
    retry.resolve("updated");
    await work;
    expect(resource.snapshot().data).toBe("updated");
  });

  it.each(["owner|store-b|2", "|store-a|1"])(
    "上下文变为%s立即清空；迟到旧响应不恢复旧内容",
    async (next) => {
      const { resource, read, change } = harness();
      read.mockResolvedValueOnce("store-a");
      await resource.load();
      const old = deferred<string>();
      read.mockReturnValueOnce(old.promise);
      const refresh = resource.load();
      change(next);
      expect(resource.snapshot()).toEqual({ data: undefined, loading: true, error: null });
      const fresh = deferred<string>();
      read.mockReturnValueOnce(fresh.promise);
      const work = resource.load();
      old.resolve("old-store-a");
      await refresh;
      expect(resource.snapshot()).toEqual({ data: undefined, loading: true, error: null });
      fresh.reject(new Error("当前资料读取失败"));
      await work;
      expect(resourceView(resource.snapshot())).toBe("error");
      expect(resource.snapshot().data).toBeUndefined();
    },
  );

  it("较新刷新完成后忽略旧失败；页面关闭后忽略迟到响应", async () => {
    const { resource, read } = harness();
    const old = deferred<string>();
    read.mockReturnValueOnce(old.promise).mockResolvedValueOnce("newest");
    const first = resource.load();
    await resource.load();
    old.reject(new Error("旧请求失败"));
    await first;
    expect(resource.snapshot()).toEqual({ data: "newest", loading: false, error: null });

    const late = deferred<string>();
    read.mockReturnValueOnce(late.promise);
    const work = resource.load();
    const before = resource.snapshot();
    resource.dispose();
    late.resolve("closed");
    await work;
    expect(resource.snapshot()).toBe(before);
  });
});
