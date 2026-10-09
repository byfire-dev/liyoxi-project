import { createMedia } from "../media/index.js";
import type { Media, MediaDeps } from "../media/index.js";
import { createRuntimeMediaBatches } from "../ops/index.js";

/** Test assembly uses the same public domain facts as the application composition root. */
export function createBatchMediaForTest(options: MediaDeps): Media {
  const media: Media = createMedia({
    ...options,
    batches: createRuntimeMediaBatches({
      clock: options.clock,
      events: options.events,
      media: () => media,
    }),
  });
  return media;
}
