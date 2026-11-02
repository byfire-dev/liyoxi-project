import { describe, expect, it, vi } from "vitest";

import type { ImageRequestResult } from "./image-request";
import { createImageRequestQueue } from "./image-request-queue";

function controlled() {
  let resolve!: (result: ImageRequestResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<ImageRequestResult>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  const abort = vi.fn();
  return { request: { promise, abort }, resolve, reject, abort };
}

const result = (): ImageRequestResult => ({ statusCode: 200, data: new ArrayBuffer(1) });
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("图片请求队列", () => {
  it("默认最多同时启动两个请求，空位按 FIFO 补齐", async () => {
    const queue = createImageRequestQueue();
    const sources = [controlled(), controlled(), controlled(), controlled()];
    const starts: number[] = [];
    const tasks = sources.map((source, index) =>
      queue.enqueue(() => {
        starts.push(index);
        return source.request;
      }),
    );
    expect(starts).toEqual([0, 1]);
    sources[1]!.resolve(result());
    await flush();
    expect(starts).toEqual([0, 1, 2]);
    sources[0]!.resolve(result());
    await flush();
    expect(starts).toEqual([0, 1, 2, 3]);
    sources[2]!.resolve(result());
    sources[3]!.resolve(result());
    expect(await Promise.all(tasks.map((task) => task.promise))).toHaveLength(4);
  });

  it("取消排队项立即拒绝且不启动，后续排队项继续", async () => {
    const queue = createImageRequestQueue(2);
    const first = controlled();
    const second = controlled();
    const fourth = controlled();
    const one = queue.enqueue(() => first.request);
    const two = queue.enqueue(() => second.request);
    const cancelledStart = vi.fn(() => controlled().request);
    const three = queue.enqueue(cancelledStart);
    const fourthStart = vi.fn(() => fourth.request);
    const four = queue.enqueue(fourthStart);
    three.abort();
    three.abort();
    await expect(three.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelledStart).not.toHaveBeenCalled();
    expect(fourthStart).not.toHaveBeenCalled();
    first.resolve(result());
    await flush();
    expect(fourthStart).toHaveBeenCalledOnce();
    expect(cancelledStart).not.toHaveBeenCalled();
    second.resolve(result());
    fourth.resolve(result());
    await Promise.all([one.promise, two.promise, four.promise]);
  });

  it.each(["resolve", "reject"] as const)(
    "运行中取消后保持占位，迟到 %s 只释放一次且不交付",
    async (settlement) => {
      const queue = createImageRequestQueue(2);
      const first = controlled();
      const second = controlled();
      const third = controlled();
      const fourth = controlled();
      first.abort.mockImplementation(() => {
        throw new Error("native abort failed");
      });
      const one = queue.enqueue(() => first.request);
      const two = queue.enqueue(() => second.request);
      const thirdStart = vi.fn(() => third.request);
      const fourthStart = vi.fn(() => fourth.request);
      const three = queue.enqueue(thirdStart);
      const four = queue.enqueue(fourthStart);
      one.abort();
      one.abort();
      await expect(one.promise).rejects.toMatchObject({ name: "AbortError" });
      expect(first.abort).toHaveBeenCalledOnce();
      expect(thirdStart).not.toHaveBeenCalled();
      if (settlement === "resolve") first.resolve(result());
      else first.reject(new Error("late native failure"));
      await flush();
      expect(thirdStart).toHaveBeenCalledOnce();
      expect(fourthStart).not.toHaveBeenCalled();
      await expect(one.promise).rejects.toMatchObject({ name: "AbortError" });
      one.abort();
      third.resolve(result());
      await flush();
      expect(fourthStart).toHaveBeenCalledOnce();
      second.resolve(result());
      fourth.resolve(result());
      await Promise.all([two.promise, three.promise, four.promise]);
    },
  );

  it("同步 start 抛错后继续补位", async () => {
    const queue = createImageRequestQueue(2);
    const first = controlled();
    const second = controlled();
    const fourth = controlled();
    const one = queue.enqueue(() => first.request);
    const two = queue.enqueue(() => second.request);
    const failure = new Error("start failed");
    const three = queue.enqueue(() => {
      throw failure;
    });
    const fourthStart = vi.fn(() => fourth.request);
    const four = queue.enqueue(fourthStart);
    first.resolve(result());
    await expect(three.promise).rejects.toBe(failure);
    expect(fourthStart).toHaveBeenCalledOnce();
    second.resolve(result());
    fourth.resolve(result());
    await Promise.all([one.promise, two.promise, four.promise]);
  });

  it("异步失败交付给消费者并启动下一项", async () => {
    const queue = createImageRequestQueue(2);
    const first = controlled();
    const second = controlled();
    const third = controlled();
    const one = queue.enqueue(() => first.request);
    const two = queue.enqueue(() => second.request);
    const thirdStart = vi.fn(() => third.request);
    const three = queue.enqueue(thirdStart);
    const failure = new Error("native failed");
    first.reject(failure);
    await expect(one.promise).rejects.toBe(failure);
    expect(thirdStart).toHaveBeenCalledOnce();
    second.resolve(result());
    third.resolve(result());
    await Promise.all([two.promise, three.promise]);
  });
});
