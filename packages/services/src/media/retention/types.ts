import type { BoundMediaDeps } from "../context.js";
import type { RetentionOptions } from "./options.js";
export type { RetentionActor, RetentionOptions } from "./options.js";
export interface RetentionDeps extends BoundMediaDeps {
  retention?: RetentionOptions;
}
export const fileMutexKey = (fileId: string) => `media:file:${fileId}`;
