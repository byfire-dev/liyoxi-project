import type { EmitContext } from "../events/index.js";
import { defineKeyedPort } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { ApprovalRow } from "./kinds.js";

export interface RecordExecutedInput {
  readonly approvalId: string;
  /** 领域行：表名与 id */
  readonly domain: { readonly type: "cancel_request" | "refund_request"; readonly id: string };
}

/** Owner-supplied real execution facts, independent of submission/decision producers. */
export type ApprovalExecutionFacts = (
  tx: Tx,
  ctx: EmitContext,
  input: RecordExecutedInput,
  row: ApprovalRow,
) => Promise<boolean>;
export const approvalExecutionFactsPort = defineKeyedPort<ApprovalExecutionFacts>(
  "approval.execution_facts",
);
