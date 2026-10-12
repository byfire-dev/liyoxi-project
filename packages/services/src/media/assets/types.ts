import type { StaffBrief } from "@liyoxi/contract";
import type { DataScope } from "../../authz/index.js";
import type { IdempotencyContext, Tx } from "../../kernel/index.js";
import type { Sla } from "../../sla/index.js";
import type { Timers } from "../../timers/index.js";
import type { AsrProvider, LlmProvider } from "../../providers/types.js";
import type { MediaActor } from "../actor.js";
import type { ModelBudgetContext, ModelBudgetDecision } from "./model-budget.js";

export type ModelBudgetFacts = Omit<ModelBudgetContext, "dailyFileCap" | "dailyCallCap">;
export interface ModelBudgetAdmission {
  readonly readPermit: (tx: Tx, facts: ModelBudgetFacts) => Promise<ModelBudgetContext | null>;
  readonly reserve: (
    context: ModelBudgetContext,
    signal: AbortSignal,
  ) => Promise<ModelBudgetDecision>;
}

export interface AssetStoreFacts {
  readonly id: string;
  readonly entityId: string;
  readonly name: string | null;
  readonly isPrimary: boolean;
  readonly qualificationStatus: string;
  readonly lifecycle: string;
}
/** Higher-layer composition supplies owned public facts, never a raw peer client. */
export interface MediaAssetsDeps {
  readonly sla: Pick<Sla, "dueAt">;
  readonly timers: Pick<Timers, "arm" | "cancel">;
  readonly asr: AsrProvider;
  readonly llm: LlmProvider;
  readonly readStore: (
    tx: Tx,
    storeId: string,
    scope?: DataScope,
  ) => Promise<AssetStoreFacts | null>;
  readonly readUploader: (
    tx: Tx,
    input: { entityId: string; actorType: string; actorId: string },
  ) => Promise<{ displayName: string | null; staff: StaffBrief | null }>;
  readonly readUsage: (
    tx: Tx,
    input: { usedByType: string; usedById: string; entityId: string; storeId: string },
  ) => Promise<{ type: "ad" | "drama_order"; id: string; no: string } | null>;
  readonly canReadEditingAsset: (
    tx: Tx,
    input: { storeId: string; staffId: string },
  ) => Promise<boolean>;
  /** Missing approved global budget configuration degrades model calls to skipped. */
  readonly allowModelCall?: (tx: Tx, input: { storeId: string; now: Date }) => Promise<boolean>;
  /** 成对端口一旦存在即为权威；不完整或失败不能回退旧授权。默认装配不提供。 */
  readonly modelBudget?: ModelBudgetAdmission;
  /** 仅组合根的自有完整回调配置可以启用真实任务标识。 */
  readonly asrCallback?: boolean;
  readonly recordUpload: (
    tx: Tx,
    actor: MediaActor,
    input: {
      assetId: string;
      storeId: string;
      entityId: string;
      type: string;
      fileCount: number;
      hasDemand: boolean;
    },
  ) => Promise<void>;
  readonly checkDemandText: (fields: { title: string; shootingNote?: string }) => Promise<void>;
}
export interface AssetWriteOptions {
  readonly idem?: IdempotencyContext;
}
export const assetTimerKey = (id: string) => `sla.breach:store_asset:${id}`;
export const assetPromptVersion = 1;
