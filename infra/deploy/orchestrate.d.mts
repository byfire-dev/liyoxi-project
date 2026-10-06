import type { ReleaseRecord, ReleaseStep } from "./node-record.mjs";

export interface StepResult {
  status: number;
  stdout: string;
  stderr: string;
}
export type Channel = (step: string, args?: string[]) => StepResult;
export interface Options {
  tag?: string;
  rollback?: boolean;
  force?: boolean;
  reason?: string;
  overrideP1?: string[];
  rollbackSafe?: boolean;
  compatibility?: string;
  freeze?: boolean;
}
export interface Summary extends ReleaseRecord {
  error: string;
  recordError: string;
  exitCode: number;
}
export const RELEASE_STEPS: ReleaseStep[];
export const ROLLBACK_STEPS: ReleaseStep[];
export function createChannel(options: {
  local?: boolean;
  node?: string;
  script?: string;
}): Channel;
export function parseFacts(stdout: string): { current: string | null; records: ReleaseRecord[] };
export function rollbackTarget(
  facts: { current: string | null; records: ReleaseRecord[] },
  requested?: string,
  force?: boolean,
  reason?: string,
): string;
export function orchestrate(
  options: Options,
  channel: Channel,
  seams?: { clock?: () => number; runId?: string },
): Summary;
export function main(args: string[], env?: NodeJS.ProcessEnv): number;
