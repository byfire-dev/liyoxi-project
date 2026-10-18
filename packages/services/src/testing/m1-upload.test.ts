import { expect, it, vi } from "vitest";
import { completeWithQueuedPromote } from "./m1-upload.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function untilAborted(signal: AbortSignal, stopped: () => void): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => {
      stopped();
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

it("complete同步或异步失败都会取消尚未入队的观察，等待与取消均收口后保留原错", async () => {
  for (const synchronous of [true, false]) {
    const failure = new Error("complete failed"),
      cancel = vi.fn(async () => {});
    let waiting = false;
    await expect(
      completeWithQueuedPromote({
        complete: () => {
          if (synchronous) throw failure;
          return Promise.reject(failure);
        },
        promote: (signal) => {
          waiting = true;
          return untilAborted(signal, () => {
            waiting = false;
          });
        },
        cancel,
      }),
    ).rejects.toBe(failure);
    expect(waiting).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  }
});

it("promote失败不丢在途complete或取消drain，双方实际settled才向外返回失败", async () => {
  const response = deferred<string>(),
    canceled = deferred<void>(),
    promotionStarted = deferred<void>(),
    failure = new Error("promote failed");
  let settled = false;
  const task = completeWithQueuedPromote({
    complete: () => response.promise,
    promote: async () => {
      promotionStarted.resolve();
      throw failure;
    },
    cancel: () => canceled.promise,
  });
  void task.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await promotionStarted.promise;
  await Promise.resolve();
  expect(settled).toBe(false);
  response.resolve("actual response");
  await Promise.resolve();
  expect(settled).toBe(false);
  canceled.resolve();
  await expect(task).rejects.toBe(failure);
  expect(settled).toBe(true);
});

it("外部取消停止请求与真实任务等待并等取消drain完成，不遗留后台分支", async () => {
  const controller = new AbortController(),
    ready = deferred<void>(),
    failure = new Error("round canceled"),
    cancel = vi.fn(async () => {});
  let active = 0;
  const pending = (signal: AbortSignal) => {
    active++;
    if (active === 2) ready.resolve();
    return untilAborted(signal, () => {
      active--;
    });
  };
  const task = completeWithQueuedPromote({
    complete: pending,
    promote: pending,
    cancel,
    signal: controller.signal,
  });
  await ready.promise;
  controller.abort(failure);
  await expect(task).rejects.toBe(failure);
  expect(active).toBe(0);
  expect(cancel).toHaveBeenCalledTimes(1);
});
