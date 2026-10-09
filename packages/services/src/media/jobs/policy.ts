import type { MediaJobKind } from "./types.js";

export const MEDIA_SCAN_LIMIT = 20;
export const MEDIA_SCAN_INTERVAL_MS = 15_000;
export const MEDIA_LOCAL_CONCURRENCY = 2;
export const MEDIA_REMOTE_CONCURRENCY = 8;
export const MEDIA_SHUTDOWN_WAIT_MS = 45_000;
export const MEDIA_POLL_INITIAL_MS = 5_000;
export const MEDIA_POLL_MAX_MS = 60_000;
export interface MediaJobBudget {
  readonly hardTimeoutMs?: number;
  readonly leaseMs: number;
  readonly deadlineMs: number;
}
const minute = 60_000;
const promote = { hardTimeoutMs: 4 * minute, leaseMs: 5 * minute, deadlineMs: 30 * minute };
const synchronous = { hardTimeoutMs: 90_000, leaseMs: 2 * minute, deadlineMs: 15 * minute };
const remote = { leaseMs: 2 * minute, deadlineMs: 30 * minute };
export const MEDIA_JOB_BUDGETS = {
  promote,
  restamp: promote,
  probe: { hardTimeoutMs: 3 * minute, leaseMs: 4 * minute, deadlineMs: 30 * minute },
  transcode_mp4: remote,
  watermark_sample: remote,
  normalize: remote,
  zip_package: { ...remote, deadlineMs: 60 * minute },
  audit_image: synchronous,
  audit_image_wx: { ...remote, deadlineMs: 35 * minute },
  audit_video: remote,
  audit_text: synchronous,
  asr: remote,
  vision: synchronous,
  doc_extract: synchronous,
  digest: synchronous,
  ocr: synchronous,
} as const satisfies Record<MediaJobKind, MediaJobBudget>;

export const jobBudget = (kind: string): MediaJobBudget | null =>
  Object.hasOwn(MEDIA_JOB_BUDGETS, kind) ? MEDIA_JOB_BUDGETS[kind as MediaJobKind] : null;
export const retryDelay = (attempt: number) =>
  [minute, 5 * minute, 15 * minute][Math.min(2, Math.max(0, attempt - 1))]!;
export const nextPollDelay = (previous: number) =>
  Math.min(MEDIA_POLL_MAX_MS, Math.max(MEDIA_POLL_INITIAL_MS, previous * 2));
