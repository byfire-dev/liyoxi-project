export interface P95Settings {
  profile: "formal" | "local";
  concurrency: number;
  scale: number;
  seed: number;
  samples: number;
  out: string;
}
export interface P95Result {
  samples: number;
  failures: number;
  errorRate: number;
  p95Ms: number;
  p50Ms: number;
  p90Ms: number;
  distribution: Record<string, number>;
  maxMs: number;
  errors: Record<string, number>;
  passed: boolean;
}
export const P95_LIMIT_MS: 500;
export const P95_OPERATION_IDS: readonly string[];
export function coverage(operationIds: readonly string[]): {
  expected: readonly string[];
  measured: string[];
  missing: string[];
  unexpected: string[];
  duplicates: string[];
  complete: boolean;
};
export function settings(args: readonly string[]): P95Settings;
export function percentile(samples: readonly number[], fraction?: number): number;
export function measure(
  request: (index: number) => Promise<unknown>,
  config: Pick<P95Settings, "concurrency" | "samples">,
): Promise<P95Result>;
export function reportPassed(report: {
  routes: ReadonlyArray<Pick<P95Result, "samples" | "failures" | "p95Ms">>;
}): boolean;
