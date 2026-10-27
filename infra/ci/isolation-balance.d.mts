export interface IsolationFile {
  readonly project: string;
  readonly file: string;
}

export interface IsolationTimings {
  readonly defaultMilliseconds: number;
  readonly weights: ReadonlyMap<string, number>;
}

export function parseIsolationTimings(value: unknown): IsolationTimings;
export function balanceIsolationShards<T extends IsolationFile>(
  baseline: readonly (readonly T[])[],
  timings: IsolationTimings,
): T[][];
