import type { BoundMediaDeps } from "../context.js";
import { createCloudProductionHandler } from "./transcode.js";
export const createNormalizeHandler = (deps: BoundMediaDeps) =>
  createCloudProductionHandler(deps, "normalize");
