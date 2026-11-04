import { useEffect, useState } from "react";
import { newIdempotencyKey } from "../../../lib/idempotency";

/** M6 发布操作：同意图重试；写已接受时只读回，不重复提交。 */
export function createPublishIntent(makeKey = () => newIdempotencyKey("publish-workbench")) {
  let busy = false,
    active = true,
    generation = 0;
  let controller = new AbortController();
  let entry:
    | { signature: string; key: string; phase: "unknown" | "accepted" | "blocked"; value?: unknown }
    | undefined;
  return {
    get pending() {
      return busy;
    },
    get phase() {
      return entry?.phase ?? "idle";
    },
    activate() {
      active = true;
      controller = new AbortController();
    },
    close() {
      active = false;
      generation++;
      busy = false;
      controller.abort();
      entry = undefined;
    },
    reset() {
      if (!busy && entry?.phase === "blocked") entry = undefined;
    },
    async run<T, W>(
      signature: unknown,
      send: (key: string, signal: AbortSignal) => Promise<W>,
      read: (signal: AbortSignal, value: W) => Promise<T>,
    ) {
      if (!active || busy) return null;
      const encoded = JSON.stringify(signature);
      if (entry && entry.signature !== encoded) throw new Error("上次结果尚未确认，请先恢复原操作");
      if (entry?.phase === "blocked") throw new Error("请刷新内容并重新确认");
      entry ??= { signature: encoded, key: makeKey(), phase: "unknown" };
      const own = generation,
        intent = entry,
        signal = controller.signal;
      const live = () => active && own === generation && !signal.aborted;
      busy = true;
      try {
        if (intent.phase !== "accepted") {
          try {
            intent.value = await send(intent.key, signal);
          } catch (error) {
            if (
              live() &&
              error &&
              typeof error === "object" &&
              "status" in error &&
              typeof error.status === "number" &&
              error.status >= 400 &&
              error.status < 500 &&
              ![408, 429].includes(error.status)
            )
              intent.phase = "blocked";
            throw error;
          }
          if (!live()) return null;
          intent.phase = "accepted";
        }
        const value = await read(signal, intent.value as W);
        if (!live()) return null;
        entry = undefined;
        return { value };
      } catch (error) {
        if (!live()) return null;
        throw error;
      } finally {
        if (own === generation) busy = false;
      }
    },
  };
}
export function usePublishWrite() {
  const [intent] = useState(createPublishIntent);
  const [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>();
  const [, render] = useState(0);
  useEffect(() => {
    intent.activate();
    return () => intent.close();
  }, [intent]);
  return {
    get pending() {
      return pending || intent.pending;
    },
    error,
    get phase() {
      return intent.phase;
    },
    abandon() {
      if (!intent.pending) {
        intent.close();
        intent.activate();
        setError(undefined);
        render((n) => n + 1);
      }
    },
    clear() {
      intent.reset();
      setError(undefined);
      render((n) => n + 1);
    },
    async run<T, W>(
      signature: unknown,
      send: (key: string, signal: AbortSignal) => Promise<W>,
      read: (signal: AbortSignal, value: W) => Promise<T>,
    ) {
      if (intent.pending) return null;
      setPending(true);
      setError(undefined);
      try {
        return await intent.run(signature, send, read);
      } catch (failure) {
        setError(failure);
        return null;
      } finally {
        setPending(false);
      }
    },
  };
}
