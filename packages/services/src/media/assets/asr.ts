import { z } from "zod";
import type { MediaJob } from "@liyoxi/db";
import { assertNotInTransaction, lockRows } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { AsrSubmissionResult, ProviderResult, AsrTaskStatus } from "../../providers/types.js";
import type { JobOutcome } from "../jobs/types.js";
import type { AssetDeps } from "./context.js";
import { AssetJobInputSchema, assetJobOwned } from "./pipeline.js";

const taskId = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/)
  .refine(
    (value) => /^(?:0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n,
  );
const identity = z.object({
  taskId,
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});
const task = z.discriminatedUnion("state", [
  identity.extend({ state: z.literal("waiting") }),
  identity.extend({ state: z.literal("doing") }),
  identity.extend({ state: z.literal("failed"), code: z.literal("recognition_failed") }),
  identity
    .extend({
      state: z.literal("succeeded"),
      text: z
        .string()
        .max(4 * 1024 ** 2)
        .refine((value) => !!value.trim()),
      durationSec: z.number().finite().positive().max(18000),
      segments: z
        .array(
          z.object({
            text: z
              .string()
              .max(4 * 1024 ** 2)
              .refine((value) => !!value.trim()),
            startMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            endMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          }),
        )
        .min(1)
        .max(100000),
    })
    .refine((value) =>
      value.segments.every(
        (segment) =>
          segment.endMs > segment.startMs && segment.endMs <= Math.ceil(value.durationSec * 1000),
      ),
    ),
]);
const cachedTranscript = z
  .object({
    text: z
      .string()
      .max(4 * 1024 ** 2)
      .refine((value) => !!value.trim()),
    durationSec: z.number().finite().positive().max(18000),
    segments: z
      .array(
        z.object({
          text: z
            .string()
            .max(4 * 1024 ** 2)
            .refine((value) => !!value.trim()),
          fromMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          toMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        }),
      )
      .min(1)
      .max(100000),
  })
  .refine((value) =>
    value.segments.every(
      (segment) =>
        segment.toMs > segment.fromMs && segment.toMs <= Math.ceil(value.durationSec * 1000),
    ),
  );
const terminal = (code: string): JobOutcome => ({
  state: "failed",
  failure: { code, retryable: false, automaticRetry: false },
});
const skipped = (reason: string): JobOutcome => ({
  state: "succeeded",
  output: { status: "skipped", reason, content: {}, verdict: null },
});

/** Asset-owned ASR lifecycle; remote acceptance is never inferred or automatically resubmitted. */
export function createAssetAsrStrategy(
  deps: AssetDeps,
  current: (tx: Tx, job: MediaJob) => Promise<boolean>,
) {
  async function admitted(job: MediaJob, modelCall: boolean) {
    if (!assetJobOwned(job)) return null;
    const input = AssetJobInputSchema.parse(job.input);
    return deps.tx.run(async (tx) => {
      await lockRows(tx, "store_asset", [input.assetId]);
      await lockRows(tx, "media_job", [job.id]);
      const fresh = await tx.mediaJob.findUnique({ where: { id: job.id } });
      const now = deps.clock.now();
      if (
        !fresh ||
        fresh.state !== job.state ||
        fresh.attemptNo !== job.attemptNo ||
        !job.leaseOwner ||
        fresh.leaseOwner !== job.leaseOwner ||
        fresh.externalJobId !== job.externalJobId ||
        fresh.nextRunAt <= now ||
        fresh.deadlineAt <= now ||
        JSON.stringify(AssetJobInputSchema.parse(fresh.input)) !== JSON.stringify(input) ||
        !(await current(tx, fresh)) ||
        !input.fileId
      )
        return null;
      const file = await tx.fileObject.findUniqueOrThrow({ where: { id: input.fileId } });
      if (file.bucket !== "asset" || !file.storeId) return null;
      const permitted =
        !modelCall ||
        !!(await deps.assets.allowModelCall?.(tx, {
          storeId: file.storeId,
          now,
        }));
      return { file, permitted };
    });
  }

  async function execute(job: MediaJob, signal: AbortSignal): Promise<JobOutcome> {
    if (signal.aborted) return { state: "canceled" };
    const first = await admitted(job, true);
    if (!first) return { state: "canceled" };
    if (!first.permitted) return skipped("budget_unconfigured");
    if (deps.assets.asr.status === "unconfigured") return skipped("asr_unconfigured");
    assertNotInTransaction("素材 ASR 源文件签名");
    const signed = await deps.storage.presignGet({
      bucket: "asset",
      key: first.file.objectKey,
      expiresSec: 7200,
    });
    if (!signed.ok) return skipped("asr_source_unavailable");
    const fresh = await admitted(job, false);
    if (
      !fresh ||
      signal.aborted ||
      fresh.file.objectKey !== first.file.objectKey ||
      fresh.file.etag !== first.file.etag
    )
      return { state: "canceled" };
    assertNotInTransaction("素材 ASR 提交");
    // A thrown/unknown reply may follow acceptance. Only manual re-understanding can retry it.
    let result: AsrSubmissionResult;
    try {
      result = await deps.assets.asr.submit({ url: signed.value.url, signal });
    } catch {
      return terminal("ASR_SUBMISSION_UNKNOWN");
    }
    if (!result.ok)
      return terminal(
        result.acceptance === "not_accepted" ? "ASR_SUBMISSION_REJECTED" : "ASR_SUBMISSION_UNKNOWN",
      );
    const parsed = identity.safeParse(result.value);
    return parsed.success
      ? { state: "submitted", externalJobId: parsed.data.taskId }
      : terminal("ASR_SUBMISSION_UNKNOWN");
  }

  async function query(job: MediaJob, signal: AbortSignal): Promise<JobOutcome> {
    // A crash before TaskId persistence must not cause another CreateRecTask request.
    if (!job.externalJobId) return terminal("ASR_SUBMISSION_UNKNOWN");
    if (!taskId.safeParse(job.externalJobId).success) return terminal("ASR_RESULT_INVALID");
    if (signal.aborted) return { state: "pending" };
    let allowed: Awaited<ReturnType<typeof admitted>>;
    try {
      allowed = await admitted(job, true);
    } catch {
      // Local admission failure must not requeue an accepted remote task for another submit.
      return { state: "pending" };
    }
    if (!allowed) return { state: "canceled" };
    if (!allowed.permitted) return skipped("budget_unconfigured");
    if (signal.aborted) return { state: "pending" };
    assertNotInTransaction("素材 ASR 回查");
    let result: ProviderResult<AsrTaskStatus>;
    try {
      result = await deps.assets.asr.query({ taskId: job.externalJobId, signal });
    } catch {
      // Query transport failure cannot reset the attempt and submit an accepted task again.
      return { state: "pending" };
    }
    if (!result.ok)
      return result.reason === "unavailable"
        ? { state: "pending" }
        : terminal("ASR_QUERY_REJECTED");
    const parsed = task.safeParse(result.value);
    if (
      !parsed.success ||
      parsed.data.taskId !== job.externalJobId ||
      Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > 4 * 1024 ** 2
    )
      return terminal("ASR_RESULT_INVALID");
    const value = parsed.data;
    if (value.state === "waiting" || value.state === "doing") return { state: "pending" };
    if (value.state === "failed") return terminal("ASR_RECOGNITION_FAILED");
    return {
      state: "succeeded",
      output: {
        status: "ok",
        reason: null,
        verdict: null,
        content: {
          text: value.text,
          durationSec: value.durationSec,
          segments: value.segments.map(({ startMs, endMs, text }) => ({
            fromMs: startMs,
            toMs: endMs,
            text,
          })),
        },
      },
    };
  }
  function validCached(value: unknown): boolean {
    const parsed = cachedTranscript.safeParse(value);
    return (
      parsed.success && Buffer.byteLength(JSON.stringify(parsed.data), "utf8") <= 4 * 1024 ** 2
    );
  }
  return { execute, poll: query, recover: query, validCached };
}
