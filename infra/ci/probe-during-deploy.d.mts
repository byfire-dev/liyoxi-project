export interface Target {
  name: string;
  url: string;
  host?: string;
  sha256?: string;
  contains?: string;
}
export interface Report {
  schemaVersion: number;
  startedAt: string;
  finishedAt: string | null;
  intervalMs: number;
  rounds: number;
  requests: number;
  failures: number;
  durationMs: number;
  targets: Array<{
    name: string;
    url: string;
    host?: string;
    requests: number;
    failures: number;
    interruptionMs: number;
    outages: Array<{
      startedAt: string;
      finishedAt: string;
      durationMs: number;
      ongoing: boolean;
      error: string;
    }>;
  }>;
}
export function validateTargets(value: unknown): Target[];
export function requestTarget(target: Target, timeoutMs?: number): Promise<string | null>;
export function checkTargets(targets: Target[]): Promise<Array<{ name: string; error: string }>>;
export function probe(options: {
  targets: Target[];
  output?: string;
  signal?: AbortSignal;
  durationMs?: number;
  onReady?: () => void;
}): Promise<Report>;
export function main(args: string[]): Promise<void>;
