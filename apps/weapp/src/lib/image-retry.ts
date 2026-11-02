export interface ImageDownloadDetails {
  readonly storageError?: string;
  readonly server?: string;
  readonly contentType?: string;
}

export interface ImageDownloadResult {
  readonly statusCode: number;
  readonly tempFilePath?: string;
  readonly details?: ImageDownloadDetails;
}

export interface ImageDownload {
  readonly promise: Promise<ImageDownloadResult>;
  abort(): void;
}

export interface ImageRetryResult {
  readonly statusCode?: number;
  readonly error?: unknown;
  readonly details?: ImageDownloadDetails;
}

/** One fallback download per activation; a disposed task cannot update a new activation. */
export function createImageRetry({
  source,
  download,
  onReady,
  onResult,
}: {
  source: string;
  download(source: string): ImageDownload;
  onReady(path: string): void;
  onResult(result: ImageRetryResult): void;
}) {
  let active = false;
  let generation = 0;
  let attempted = false;
  let pending: ImageDownload | undefined;

  const abort = (task: ImageDownload | undefined) => {
    try {
      task?.abort();
    } catch {
      // Native cancellation errors must not revive a disposed task or interrupt cleanup.
    }
  };
  const report = (result: ImageRetryResult) => {
    try {
      onResult(result);
    } catch {
      // Diagnostic callbacks cannot stop a valid image from becoming ready.
    }
  };

  return {
    activate() {
      if (active) return;
      active = true;
      generation++;
      attempted = false;
    },
    retry() {
      if (!active || attempted) return;
      attempted = true;
      const requestedGeneration = generation;
      const isCurrent = () => active && generation === requestedGeneration;
      const fail = (error: unknown) => {
        if (!isCurrent()) return;
        pending = undefined;
        report({ error });
      };
      try {
        const task = download(source);
        if (isCurrent()) pending = task;
        else abort(task);
        void task.promise.then((result) => {
          if (!isCurrent()) return;
          pending = undefined;
          report({
            statusCode: result.statusCode,
            ...(result.details === undefined ? {} : { details: result.details }),
          });
          if (!isCurrent() || result.statusCode !== 200 || !result.tempFilePath?.trim()) return;
          try {
            onReady(result.tempFilePath);
          } catch {
            // A consumer callback must not create an unhandled promise rejection.
          }
        }, fail);
      } catch (error) {
        fail(error);
      }
    },
    dispose() {
      active = false;
      generation++;
      const task = pending;
      pending = undefined;
      abort(task);
    },
  };
}
