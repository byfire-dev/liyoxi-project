import type { createTaroUpload } from "@/lib/upload/taro";
type Job = Pick<ReturnType<typeof createTaroUpload>, "start" | "retry" | "cancel" | "dispose">;

export function createScreenshotUpload(
  job: Job,
  capture: () => () => boolean,
  onStored: (fileId: string) => void,
) {
  let waiting = false;
  let delivered = false;
  let removed = false;
  return {
    async finish(retry = false) {
      if (waiting || delivered || removed) return;
      waiting = true;
      const current = capture();
      try {
        const result = await (retry ? job.retry() : job.start());
        if (removed || !current() || !result) return;
        delivered = true;
        onStored(result.fileId);
        job.dispose();
      } finally {
        waiting = false;
      }
    },
    remove() {
      removed = true;
      return job.cancel();
    },
  };
}
