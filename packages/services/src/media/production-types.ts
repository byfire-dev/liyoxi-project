import type { FileObject, ProductionRecord } from "@liyoxi/db";
import type { ProductionCheckContext, ProductionCheckOptions } from "@liyoxi/shared";
import type { Tx } from "../kernel/index.js";
import type {
  AigcLabel,
  MediaProvider,
  MediaToolClient,
  MediaWorkspace,
} from "../providers/types.js";
export interface MediaProductionConfig {
  readonly aigc: Omit<AigcLabel, "ProduceID" | "PropagateID">;
  readonly templates: {
    readonly normalize: string;
    readonly sd: string;
    readonly hd: string;
    readonly sample: string;
    readonly brand: string;
    readonly ai: string;
  };
}
interface MediaProductionBase {
  readonly tool: MediaToolClient;
  readonly workspace: MediaWorkspace;
  readonly cloud: MediaProvider;
  readonly parameters: (
    tx: Tx,
  ) => Promise<ProductionCheckOptions & { ruleVersion: number; specVersion: number }>;
  /** Typed fact read in the caller's transaction; no higher-layer imports in media. */
  readonly readStoreFacts: (tx: Tx, storeId: string) => Promise<{ name: string } | null>;
  readonly readAdDurations?: (
    tx: Tx,
    ids: { head: string | null; tail: string | null },
  ) => Promise<{ headAdMs: number; tailAdMs: number } | null>;
  readonly readAdKind?: (tx: Tx, adId: string) => Promise<"head" | "tail" | null>;
  readonly readMasterFacts?: (
    tx: Tx,
    masterId: string,
  ) => Promise<{
    id: string;
    durationMs: number;
    displayWidth: number;
    displayHeight: number;
    isCurrent: boolean;
  } | null>;
  readonly readTrailerFacts?: (
    tx: Tx,
    dramaId: string,
  ) => Promise<{
    dramaId: string;
    isAiGenerated: boolean;
    posterFileId: string | null;
    targetPlayableAssetId: string | null;
    currentPlayableAssetId: string | null;
  } | null>;
  readonly setTrailerTarget?: (
    tx: Tx,
    input: { dramaId: string; playableAssetId: string; staffId: string; now: Date },
  ) => Promise<void>;
  readonly installTrailerCurrent?: (
    tx: Tx,
    input: { dramaId: string; playableAssetId: string; now: Date },
  ) => Promise<{
    changed: boolean;
    oldCurrentPlayableAssetId: string | null;
  }>;
  /** Only the parent domain can converge a batch; receives the same locked result transaction. */
  readonly productionChecked?: (
    tx: Tx,
    input: { fileId: string; gate: "pass" | "reject"; derivedFromFileId: string | null },
  ) => Promise<void>;
  readonly batchConverge?: (tx: Tx, batchId: string, now: Date) => Promise<void>;
  readonly batchLockSiblings?: (tx: Tx, batchId: string) => Promise<void>;
  readonly batchNeedsJob?: (tx: Tx, input: { batchId: string; fileId: string }) => Promise<boolean>;
}
/** Legacy callers without an explicit mode retain the complete production pipeline. */
export type MediaProductionDeps = MediaProductionBase &
  (
    | { readonly mode?: "full"; readonly config: MediaProductionConfig }
    | { readonly mode: "probe_only"; readonly config: null }
    | { readonly mode: "local_sample_watermark"; readonly config: null }
  );
export interface ProductionWorkFacts {
  readonly file: FileObject;
  readonly production: ProductionRecord | null;
  readonly context: ProductionCheckContext | null;
  readonly parameters: ProductionCheckOptions & { ruleVersion: number; specVersion: number };
}
