import type { ImageRequest, ImageRequestResult } from "./image-request";

/** Keep cancelled native requests in their slot until the transport settles. */
export function createImageRequestQueue(limit = 2) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Invalid image request limit");
  const pending: Array<() => void> = [];
  let active = 0;
  let draining = false;

  const drain = () => {
    if (draining) return;
    draining = true;
    try {
      while (active < limit) {
        const run = pending.shift();
        if (!run) break;
        run();
      }
    } finally {
      draining = false;
    }
  };

  return {
    enqueue(start: () => ImageRequest): ImageRequest {
      let resolve!: (result: ImageRequestResult) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<ImageRequestResult>((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
      // Cancellation can happen before a consumer has attached its own handler.
      void promise.catch(() => undefined);
      let cancelled = false;
      let finished = false;
      let request: ImageRequest | undefined;

      const finish = (deliver: () => void) => {
        if (finished) return;
        finished = true;
        active--;
        request = undefined;
        if (!cancelled) deliver();
        drain();
      };
      const run = () => {
        active++;
        try {
          request = start();
          void request.promise.then(
            (result) => finish(() => resolve(result)),
            (error: unknown) => finish(() => reject(error)),
          );
        } catch (error) {
          finish(() => reject(error));
        }
      };

      pending.push(run);
      drain();
      return {
        promise,
        abort() {
          if (cancelled || finished) return;
          cancelled = true;
          const error = new Error("Image request aborted");
          error.name = "AbortError";
          reject(error);
          const index = pending.indexOf(run);
          if (index >= 0) pending.splice(index, 1);
          try {
            request?.abort();
          } catch {
            // A native abort failure cannot free a still-running transport's slot.
          }
        },
      };
    },
  };
}
