export interface ReleaseChecksInput {
  repository: string;
  source: string;
  images: unknown;
  mixed: unknown;
}
export interface ReleaseChecksResult {
  source: string;
  repository: string;
  compatibility: "passed";
  imagesRunId: number;
  imagesAttempt: number;
  mixedRunId: number;
  mixedAttempt: number;
}
export function releaseCheckRequests(
  repository: string,
  source: string,
): Record<"images" | "mixed-smoke", string>;
export function selectReleaseChecks(input: ReleaseChecksInput): ReleaseChecksResult;
export function main(args: string[], env?: NodeJS.ProcessEnv): ReleaseChecksResult;
