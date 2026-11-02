import { newIdempotencyKey } from "../../../lib/idempotency";

/** One mounted order/item owns its request. Acknowledged POSTs are followed by GET only. */
export function createOrderIntent<T>(
  read: (signal: AbortSignal) => Promise<T>,
  newKey = () => newIdempotencyKey("order-aftercare"),
  definiteRejection: (error: unknown) => boolean = () => false,
) {
  let controller = new AbortController(),
    closed = false,
    busy = false;
  let identity = "",
    key = "",
    uncertain = false,
    accepted = false;
  return {
    activate() {
      if (closed) {
        controller = new AbortController();
        closed = false;
      }
    },
    close() {
      closed = true;
      controller.abort();
    },
    active: () => !closed,
    accepted: () => accepted,
    locked: () => uncertain || accepted,
    identity: () => identity,
    canClose: () => !busy && !uncertain && !accepted,
    async refresh(): Promise<T | null> {
      if (closed || busy) return null;
      busy = true;
      const own = controller;
      try {
        const value = await read(own.signal);
        return closed || own.signal.aborted ? null : value;
      } finally {
        busy = false;
      }
    },
    async submit(
      next: string,
      unchanged: (fresh: T) => boolean,
      write: (fresh: T, key: string, signal: AbortSignal) => Promise<void>,
    ): Promise<T | null> {
      if (closed || busy) return null;
      busy = true;
      const own = controller;
      try {
        if (identity !== next && uncertain)
          throw new Error("原操作结果未确认，请先刷新或以原正文重试");
        if (identity !== next && !accepted) {
          identity = next;
          key = newKey();
          uncertain = false;
          accepted = false;
        }
        const fresh = await read(own.signal);
        if (closed || own.signal.aborted) return null;
        if (accepted || (uncertain && !unchanged(fresh))) return fresh;
        uncertain = true;
        try {
          await write(fresh, key, own.signal);
        } catch (error) {
          if (definiteRejection(error)) uncertain = false;
          throw error;
        }
        accepted = true;
        uncertain = false;
        if (closed || own.signal.aborted) return null;
        const result = await read(own.signal);
        return closed || own.signal.aborted ? null : result;
      } finally {
        busy = false;
      }
    },
  };
}
