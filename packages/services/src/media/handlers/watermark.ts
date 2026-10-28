import type { BoundMediaDeps } from "../context.js";
import { createCloudProductionHandler } from "./transcode.js";
import { createLocalWatermarkHandler } from "./local-watermark.js";
export const createWatermarkHandler = (deps: BoundMediaDeps) =>
  deps.production?.mode === "local_sample_watermark"
    ? createLocalWatermarkHandler(deps)
    : createCloudProductionHandler(deps, "watermark_sample");
