import { createFileActions } from "./file-actions.js";
import { createRetentionAdmin } from "./admin.js";
import type { RetentionDeps } from "./types.js";
export function createMediaRetention(deps: RetentionDeps) {
  return { ...createRetentionAdmin(deps), ...createFileActions(deps) };
}
