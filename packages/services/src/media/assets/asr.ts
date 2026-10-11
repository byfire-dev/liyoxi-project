import { z } from "zod";
import { createHash } from "node:crypto";
import type { MediaJob } from "@liyoxi/db";
import { assertNotInTransaction, lockRows } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { isAsrSubmitUrl, isAsrQueryTaskId } from "../../providers/types.js";
import type { AsrSubmissionResult, ProviderResult, AsrTaskStatus } from "../../providers/types.js";
import type { JobOutcome } from "../jobs/types.js";
import type { AssetDeps } from "./context.js";
import { AssetJobInputSchema, assetJobOwned, currentAssetRun } from "./pipeline.js";
import {
  admitModel,
  hasModelBudget,
  completeModelBudget,
  modelBudgetFailure,
  readModelJob,
  modelPermitCurrent,
} from "./model-admission.js";
import type { ModelBudgetContext } from "./model-budget.js";

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
  async function budgetSource(
    tx: Tx,
    job: MediaJob,
    signedFile?: { objectKey: string; etag: string | null },
  ) {
    const graph = await readModelJob(deps, tx, job, current);
    if (!graph) return null;
    const input = AssetJobInputSchema.parse(job.input);
    const file = graph.files.find((row) => row.fileId === input.fileId)?.file;
    const run = await currentAssetRun(tx, graph.asset.id);
    if (
      !file ||
      !run ||
      run.runId !== input.runId ||
      run.promptVersion !== input.promptVersion ||
      file.scopeType !== "store" ||
      file.entityId !== graph.asset.entityId ||
      file.storeId !== graph.asset.storeId ||
      file.category !== "store_asset" ||
      file.bucket !== "asset" ||
      file.status !== "stored" ||
      file.moderationState === "block" ||
      !file.etag ||
      file.etag !== input.etag ||
      file.crc64 !== input.crc64 ||
      file.sizeBytes?.toString() !== input.sizeBytes ||
      (signedFile && (file.objectKey !== signedFile.objectKey || file.etag !== signedFile.etag))
    )
      return null;
    return {
      entityId: graph.asset.entityId,
      storeId: graph.asset.storeId,
      fileIds: [file.id],
      expectedSourceHash: createHash("sha256")
        .update(
          JSON.stringify({
            asset: [graph.asset.id, graph.asset.entityId, graph.asset.storeId, graph.asset.type],
            run,
            job: [
              job.id,
              job.kind,
              job.provider,
              job.parentType,
              job.parentId,
              job.subjectType,
              job.subjectId,
              job.dedupeKey,
              job.attemptNo,
              job.externalJobId,
            ],
            input,
            files: graph.files.map(({ file: value, position }) => [
              position,
              value.id,
              value.entityId,
              value.storeId,
              value.scopeType,
              value.category,
              value.bucket,
              value.objectKey,
              value.ext,
              value.etag,
              value.crc64,
              value.sha256,
              value.sizeBytes?.toString(),
              value.status,
              value.moderationState,
              value.mediaInfo?.coverFileId,
            ]),
          }),
        )
        .digest("hex"),
    };
  }
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
    const paired = hasModelBudget(deps);
    try {
      if (paired && !completeModelBudget(deps)) return modelBudgetFailure("unavailable");
      if (paired && job.externalJobId) return terminal("ASR_SUBMISSION_UNKNOWN");
      const first = await admitted(job, !paired);
      if (!first) return { state: "canceled" };
      if (!first.permitted) return skipped("budget_unconfigured");
      if (deps.assets.asr.status === "unconfigured") return skipped("asr_unconfigured");
      const original = paired ? await deps.tx.run((tx) => budgetSource(tx, job, first.file)) : null;
      if (paired && !original) return { state: "canceled" };
      assertNotInTransaction("素材 ASR 源文件签名");
      const signed = await deps.storage.presignGet({
        bucket: "asset",
        key: first.file.objectKey,
        expiresSec: 7200,
      });
      if (!signed.ok) return skipped("asr_source_unavailable");
      const url = signed.value.url;
      let permit: ModelBudgetContext | undefined;
      if (paired) {
        if (!isAsrSubmitUrl(url)) return skipped("asr_source_unavailable");
        if (!original) return { state: "canceled" };
        const outcome = await admitModel(
          deps,
          job,
          signal,
          async (tx) => {
            const source = await budgetSource(tx, job);
            return source?.expectedSourceHash === original.expectedSourceHash ? source : null;
          },
          signed.value.expiresAt.getTime(),
        );
        if ("state" in outcome) return outcome;
        permit = outcome.permit;
      }
      const fresh = paired ? first : await admitted(job, false);
      if (
        !fresh ||
        signal.aborted ||
        fresh.file.objectKey !== first.file.objectKey ||
        fresh.file.etag !== first.file.etag
      )
        return { state: "canceled" };
      assertNotInTransaction("素材 ASR 提交");
      if (permit && !modelPermitCurrent(deps, permit, signal)) return { state: "canceled" };
      // A thrown/unknown reply may follow acceptance. Only manual re-understanding can retry it.
      let result: AsrSubmissionResult;
      try {
        result = await deps.assets.asr.submit({ url, signal });
      } catch {
        return terminal("ASR_SUBMISSION_UNKNOWN");
      }
      if (!result.ok)
        return terminal(
          result.acceptance === "not_accepted"
            ? "ASR_SUBMISSION_REJECTED"
            : "ASR_SUBMISSION_UNKNOWN",
        );
      const parsed = identity.safeParse(result.value);
      return parsed.success
        ? { state: "submitted", externalJobId: parsed.data.taskId }
        : terminal("ASR_SUBMISSION_UNKNOWN");
    } catch (error) {
      if (!paired) throw error;
      return signal.aborted ? { state: "canceled" } : modelBudgetFailure("unavailable");
    }
  }

  async function query(job: MediaJob, signal: AbortSignal): Promise<JobOutcome> {
    // A crash before TaskId persistence must not cause another CreateRecTask request.
    if (!job.externalJobId) return terminal("ASR_SUBMISSION_UNKNOWN");
    if (!isAsrQueryTaskId(job.externalJobId)) return terminal("ASR_RESULT_INVALID");
    if (signal.aborted) return { state: "pending" };
    let permitted: boolean;
    try {
      if (hasModelBudget(deps)) {
        const allowed = await deps.tx.run(async (tx) => {
          const source = await budgetSource(tx, job);
          if (!source) return null;
          const legacy = deps.assets.allowModelCall
            ? !!(await deps.assets.allowModelCall(tx, {
                storeId: source.storeId,
                now: deps.clock.now(),
              }))
            : true;
          return completeModelBudget(deps) && legacy;
        });
        if (allowed === null) return { state: "canceled" };
        permitted = allowed;
        const now = deps.clock.now();
        if (job.nextRunAt <= now || job.deadlineAt <= now) return { state: "canceled" };
      } else {
        const allowed = await admitted(job, true);
        if (!allowed) return { state: "canceled" };
        permitted = allowed.permitted;
      }
    } catch {
      // Local admission failure must not requeue an accepted remote task for another submit.
      return { state: "pending" };
    }
    if (!permitted) return skipped("budget_unconfigured");
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
