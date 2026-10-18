/** Per-upload test transport: retain both outcomes and stop owned media IO before returning failure. */
export async function completeWithQueuedPromote<T>(input: {
  complete(signal: AbortSignal): Promise<T>;
  promote(signal: AbortSignal): Promise<void>;
  cancel(): Promise<void>;
  signal?: AbortSignal;
}): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]);
  signal.throwIfAborted();
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= Promise.resolve().then(() => input.cancel());
    void stopping.catch(() => undefined);
  };
  signal.addEventListener("abort", stop, { once: true });
  const completion = Promise.resolve().then(() => input.complete(signal));
  const promotion = Promise.resolve().then(() => input.promote(signal));
  for (const task of [completion, promotion])
    void task.catch((error: unknown) => controller.abort(error));
  try {
    const [completed, promoted] = await Promise.allSettled([completion, promotion]);
    const stopped = stopping ? await Promise.allSettled([stopping]) : [];
    const errors: unknown[] = [];
    for (const result of [completed, promoted, ...stopped])
      if (result.status === "rejected" && !errors.includes(result.reason))
        errors.push(result.reason);
    if (signal.aborted && !errors.includes(signal.reason)) errors.push(signal.reason);
    if (errors.length > 1) throw new AggregateError(errors, "M1 complete 与 promote 未完整收口");
    if (errors.length) throw errors[0];
    if (completed.status !== "fulfilled") throw new Error("M1 complete 缺少完成结果");
    return completed.value;
  } finally {
    signal.removeEventListener("abort", stop);
    controller.abort();
  }
}
