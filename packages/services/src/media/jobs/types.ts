import type { MediaJob } from "@liyoxi/db";
import type { EnumValue, MEDIA_JOB_KIND, MEDIA_JOB_PARENT_TYPE } from "@liyoxi/contract/enums";
import type { Clock, IdentityContext, QueueChannel, Tx, TxRunner } from "../../kernel/index.js";

export type MediaJobKind = EnumValue<typeof MEDIA_JOB_KIND>;
export type MediaParentType = EnumValue<typeof MEDIA_JOB_PARENT_TYPE>;
export type JobJson =
  null | boolean | number | string | readonly JobJson[] | { readonly [key: string]: JobJson };
export type JobFailure = {
  readonly code: string;
  readonly retryable: boolean;
  readonly automaticRetry?: false;
};
export type JobOutcome =
  | { readonly state: "succeeded"; readonly output: JobJson }
  | { readonly state: "failed"; readonly failure: JobFailure }
  | { readonly state: "submitted"; readonly externalJobId: string; readonly nextRunAt?: Date }
  | { readonly state: "pending" }
  | { readonly state: "canceled" };

/** The context can contain ephemeral identity facts; it is never persisted or logged. */
export interface MediaJobHandler {
  readonly kind: MediaJobKind;
  readonly mode: "local" | "remote";
  readonly provider?: string;
  claims?(job: MediaJob): boolean;
  validInput(input: unknown): boolean;
  validOutput(output: unknown): boolean;
  current(tx: Tx, job: MediaJob): Promise<boolean>;
  prepare?(tx: Tx, job: MediaJob): Promise<unknown>;
  execute(job: MediaJob, context: unknown, signal: AbortSignal): Promise<JobOutcome>;
  recover?(job: MediaJob, signal: AbortSignal): Promise<JobOutcome>;
  poll?(job: MediaJob, signal: AbortSignal): Promise<JobOutcome>;
  cancel?(job: MediaJob, signal: AbortSignal): Promise<void>;
  /** Called after parent -> job locks, in the same transaction as the guarded job result. */
  finish?(
    tx: Tx,
    job: MediaJob,
    outcome: JobOutcome,
    ctx: IdentityContext,
  ): Promise<void | readonly string[]>;
  canRetry?(tx: Tx, job: MediaJob): Promise<boolean>;
  retry?(tx: Tx, job: MediaJob): Promise<void>;
}

export interface MediaConvergenceHandler {
  readonly parentType: MediaParentType;
  /** Lock siblings at the same parent rank, before the runner acquires any job row. */
  lockSiblings?(tx: Tx, parentId: string): Promise<void>;
  /** The implementation uses the same pure decision as normal result settlement. */
  converge(tx: Tx, parentId: string, now: Date): Promise<void>;
  needed(tx: Tx, job: MediaJob): Promise<boolean>;
}

export interface MediaJobsOptions {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly ownerId: string;
  readonly channel?: Pick<QueueChannel, "enqueue">;
  readonly handlers: readonly MediaJobHandler[];
  readonly convergenceHandlers?: readonly MediaConvergenceHandler[];
}
