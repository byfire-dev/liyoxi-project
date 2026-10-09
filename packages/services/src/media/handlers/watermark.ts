import type { BoundMediaDeps } from "../context.js";
import { createCloudProductionHandler } from "./transcode.js";
export const createWatermarkHandler = (deps: BoundMediaDeps) =>
  createCloudProductionHandler(deps, "watermark_sample");
