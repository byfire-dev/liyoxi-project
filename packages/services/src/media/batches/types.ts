import type { UploadBatch } from "@liyoxi/db";
import type { StaffBrief } from "@liyoxi/contract";
import type { StaffContext } from "../../authz/index.js";
import type { Tx, IdentityContext } from "../../kernel/index.js";
import type { BoundMediaDeps } from "../context.js";

export interface BatchTargetFacts {
  expectedCount: number;
  entityId: string | null;
  storeId: string | null;
  targetLabel: string;
  forcedByDrama: boolean;
  episodes: readonly { episodeNo: number; title: string | null }[];
  masters: readonly { id: string; episodeNo: number; durationMs: number | null; fileId: string }[];
  productionContext: {
    headAdVersionId: string | null;
    tailAdVersionId: string | null;
    productionTier: string;
  } | null;
}
export interface MediaBatchDeps {
  readStaffBrief(tx: Tx, staffId: string): Promise<StaffBrief | null>;
  readTarget(tx: Tx, input: { purpose: string; targetId: string }): Promise<BatchTargetFacts>;
  authorizeTarget(
    tx: Tx,
    staff: StaffContext,
    input: { purpose: string; targetId: string; lock: boolean; readOnly: boolean },
  ): Promise<BatchTargetFacts>;
  commitMasters(
    tx: Tx,
    input: {
      batch: UploadBatch;
      staff: StaffContext;
      identity: IdentityContext;
      items: readonly { episodeNo: number; fileId: string; durationMs: number | null }[];
    },
  ): Promise<readonly { episodeNo: number; dramaEpisodeMasterId: string; revNo: number }[]>;
  currentMaster(tx: Tx, batch: UploadBatch, episodeNo: number): Promise<string | null>;
}
export type BatchRuntimeDeps = BoundMediaDeps & { readonly batches: MediaBatchDeps };
