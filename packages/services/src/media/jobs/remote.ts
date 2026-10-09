import type { MediaProvider, MediaRemoteJob, ObjectRef } from "../../providers/types.js";
import { jobBudget } from "./policy.js";
import type { MediaJobHandler, JobOutcome } from "./types.js";

export type RemoteMediaSubmission =
  | {
      readonly tag: "Transcode";
      readonly src: ObjectRef;
      readonly dst: ObjectRef;
      readonly template: string;
    }
  | {
      readonly tag: "FileCompress";
      readonly bucket: "media";
      readonly items: readonly { key: string; name: string }[];
      readonly dstKey: string;
    };
export interface RemoteMediaHandlerOptions {
  readonly provider: MediaProvider;
  readonly now: () => Date;
  readonly definition: Omit<
    MediaJobHandler,
    "mode" | "provider" | "execute" | "recover" | "poll" | "cancel"
  >;
  /** Pure bounded input mapping; business/provenance checks remain in current/finish. */
  readonly submission: (input: unknown) => RemoteMediaSubmission;
}
const pending = (): JobOutcome => ({ state: "pending" });
function outcome(job: MediaRemoteJob, userData: string): JobOutcome {
  if (!job.processed || job.userData !== userData)
    return { state: "failed", failure: { code: "MEDIA_REMOTE_RESULT_INVALID", retryable: false } };
  if (job.state === "succeeded") return { state: "succeeded", output: { ...job.output } };
  if (job.state === "failed")
    return { state: "failed", failure: { code: "CI_TASK_FAILED", retryable: true } };
  if (job.state === "canceled") return { state: "canceled" };
  return { state: "submitted", externalJobId: job.jobId };
}
export function createRemoteMediaHandler(options: RemoteMediaHandlerOptions): MediaJobHandler {
  const provider = options.provider;
  const userData = (job: Parameters<MediaJobHandler["execute"]>[0]) => `${job.id}:${job.attemptNo}`;
  async function query(
    job: Parameters<MediaJobHandler["execute"]>[0],
    signal: AbortSignal,
  ): Promise<JobOutcome> {
    const submission = options.submission(job.input),
      family = submission.tag === "FileCompress" ? "file" : "media";
    if (!provider.describe || !job.externalJobId) return pending();
    const result = await provider.describe({ jobId: job.externalJobId, family, signal });
    return result.ok ? outcome(result.value, userData(job)) : pending();
  }
  const handler: MediaJobHandler = {
    ...options.definition,
    mode: "remote",
    provider: provider.status,
    execute: async (job, _context, signal) => {
      const submission = options.submission(job.input);
      const result =
        submission.tag === "Transcode"
          ? await provider.transcode({ ...submission, userData: userData(job), signal })
          : await provider.pack({
              ...submission,
              items: [...submission.items],
              userData: userData(job),
              signal,
            });
      if (!result.ok)
        return result.reason === "unavailable"
          ? pending()
          : {
              state: "failed",
              failure: {
                code:
                  result.reason === "unconfigured" || result.reason === "unsupported"
                    ? "MEDIA_PROVIDER_UNSUPPORTED"
                    : "CI_SUBMIT_REJECTED",
                retryable: false,
              },
            };
      if (!result.value.processed)
        return { state: "failed", failure: { code: "MEDIA_NOT_PROCESSED", retryable: false } };
      return { state: "submitted", externalJobId: result.value.jobId };
    },
    recover: async (job, signal) => {
      const submission = options.submission(job.input),
        family = submission.tag === "FileCompress" ? "file" : "media";
      if (!provider.find) return pending();
      const found = await provider.find({
        family,
        tag: submission.tag,
        userData: userData(job),
        ...(submission.tag === "Transcode" ? { src: submission.src } : {}),
        createdAfter: new Date(
          Math.max(
            job.createdAt.getTime(),
            job.deadlineAt.getTime() - jobBudget(job.kind)!.deadlineMs,
          ) - 1000,
        ),
        createdBefore: new Date(options.now().getTime() + 1000),
        signal,
      });
      if (!found.ok) return pending();
      if (found.value.job) {
        if (!found.value.job.processed || found.value.job.userData !== userData(job))
          return {
            state: "failed",
            failure: { code: "MEDIA_REMOTE_RESULT_INVALID", retryable: false },
          };
        return { state: "submitted", externalJobId: found.value.job.jobId };
      }
      // A truncated search or transport failure is never evidence that submission did not happen.
      if (!found.value.complete) return pending();
      return handler.execute(job, undefined, signal);
    },
    poll: query,
    cancel: async (job, signal) => {
      if (!job.externalJobId || !provider.cancel) return;
      const family = options.submission(job.input).tag === "FileCompress" ? "file" : "media";
      await provider.cancel({ jobId: job.externalJobId, family, signal });
    },
  };
  return handler;
}
