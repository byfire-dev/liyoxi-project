import { createFileActions } from "./file-actions.js";
import { createRetentionAdmin } from "./admin.js";
import type { RetentionDeps } from "./types.js";
import { createMediaSweep } from "./sweep.js";
import { findI8Violations } from "./sweep-invariants.js";
import type { InvariantScope, Tx } from "../../kernel/index.js";
export function createMediaRetention(deps: RetentionDeps) {
  return {
    ...createRetentionAdmin(deps),
    ...createFileActions(deps),
    sweep: createMediaSweep(deps),
    checkI8: (tx: Tx, scope: InvariantScope, now: Date) => findI8Violations(deps, tx, scope, now),
  };
}
export type MediaRetention = ReturnType<typeof createMediaRetention>;
