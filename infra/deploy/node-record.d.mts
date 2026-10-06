export type ReleaseStep =
  | "precheck"
  | "facts"
  | "preflight"
  | "image-facts"
  | "pull"
  | "check-env"
  | "stage-assets"
  | "verify-assets"
  | "verify-assets-live"
  | "migrate"
  | "seed"
  | "worker-swap"
  | "api-stop"
  | "api-start"
  | "status"
  | "verify-db"
  | "smoke"
  | "prune";
export interface ReleaseRecord {
  schemaVersion: 1;
  runId: string;
  action: "release" | "rollback";
  version: string;
  previousVersion: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  result: "success" | "failure";
  failedStep: ReleaseStep | null;
  onlineTouched: boolean;
  runtimeTouched: boolean;
  rollbackSafe: boolean;
  reason: string;
  overrideP1: string[];
  p1: "unavailable" | "clear" | "overridden" | "blocked";
  compatibility: "unavailable" | "passed" | "failed";
  imageDigests: { server: string | null; gateway: string | null; mediatool: string | null };
  steps: Array<{ name: ReleaseStep; durationMs: number; exitCode: number }>;
}
export const RECORD_LIMIT: number;
export function validateRecord(record: unknown): ReleaseRecord;
export function readRecords(path: string): ReleaseRecord[];
export function protectedVersions(records: ReleaseRecord[], current: string): string[];
export function main(args: string[], path?: string): void;
