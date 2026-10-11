import type { MediaJob } from "@liyoxi/db";
import { assertNotInTransaction, isInTransaction, lockRows } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { JobOutcome } from "../jobs/types.js";
import type { AssetDeps } from "./context.js";
import type { ModelBudgetContext, ModelBudgetDecision } from "./model-budget.js";
import type { ModelBudgetFacts } from "./types.js";
import { AssetJobInputSchema, assetJobOwned } from "./pipeline.js";
import { assetFiles, lockAssetFiles } from "./repo.js";

export interface ModelAdmissionSource {
  readonly entityId: string;
  readonly storeId: string;
  readonly fileIds: readonly string[];
  readonly expectedSourceHash: string;
}
export const hasModelBudget = (deps: AssetDeps) => "modelBudget" in deps.assets;
export const completeModelBudget = (deps: AssetDeps) =>
  typeof deps.assets.modelBudget?.readPermit === "function" &&
  typeof deps.assets.modelBudget?.reserve === "function";
export function modelPermitCurrent(
  deps: AssetDeps,
  permit: ModelBudgetContext,
  signal: AbortSignal,
) {
  const now = deps.clock.now().getTime();
  return (
    !signal.aborted &&
    now >= permit.readAtMs &&
    now < permit.admitUntilMs &&
    now < permit.leaseUntilMs &&
    now < permit.originalDeadlineMs
  );
}
export function modelBudgetFailure(reason: string): JobOutcome {
  if (reason === "stale" || reason === "duplicate") return { state: "canceled" };
  return {
    state: "succeeded",
    output: {
      status: "skipped",
      reason:
        reason === "disabled"
          ? "budget_unconfigured"
          : reason === "quota_global" || reason === "quota_store"
            ? "budget_exhausted"
            : "budget_unavailable",
      content: {},
      verdict: null,
    },
  };
}
export function sameModelJob(fresh: MediaJob, job: MediaJob, provider: string) {
  return (
    assetJobOwned(fresh) &&
    fresh.kind === job.kind &&
    fresh.state === job.state &&
    fresh.provider === provider &&
    fresh.provider === job.provider &&
    fresh.attemptNo === job.attemptNo &&
    !!job.leaseOwner &&
    fresh.leaseOwner === job.leaseOwner &&
    fresh.externalJobId === job.externalJobId &&
    fresh.nextRunAt.getTime() === job.nextRunAt.getTime() &&
    fresh.deadlineAt.getTime() === job.deadlineAt.getTime() &&
    JSON.stringify(fresh.input) === JSON.stringify(job.input)
  );
}

/** ASR/摘要的有界图；父锁保护来源写入，最后410之后只重读，不补低锁。 */
export async function readModelJob(
  deps: AssetDeps,
  tx: Tx,
  job: MediaJob,
  current: (tx: Tx, job: MediaJob) => Promise<boolean>,
) {
  if (!assetJobOwned(job)) return null;
  const input = AssetJobInputSchema.parse(job.input);
  await lockRows(tx, "store_asset", [input.assetId]);
  await lockRows(tx, "media_job", [job.id]);
  const links = await assetFiles(tx, input.assetId);
  const graph = (rows: typeof links) =>
    JSON.stringify(rows.map((row) => [row.fileId, row.position, row.file.mediaInfo?.coverFileId]));
  await lockAssetFiles(tx, [
    ...links.flatMap((row) => [
      row.fileId,
      ...(row.file.mediaInfo?.coverFileId ? [row.file.mediaInfo.coverFileId] : []),
    ]),
    ...(input.coverFileId ? [input.coverFileId] : []),
  ]);
  const files = await assetFiles(tx, input.assetId);
  if (graph(files) !== graph(links)) return null;
  const fresh = await tx.mediaJob.findUnique({ where: { id: job.id } });
  const provider = job.kind === "asr" ? deps.assets.asr.status : deps.assets.llm.status;
  if (!fresh || !sameModelJob(fresh, job, provider) || !(await current(tx, fresh))) return null;
  const asset = await tx.storeAsset.findUnique({ where: { id: input.assetId } });
  if (!asset) return null;
  if (
    files.some(
      ({ file }) =>
        file.entityId !== asset.entityId ||
        file.storeId !== asset.storeId ||
        file.scopeType !== "store" ||
        file.category !== "store_asset" ||
        file.bucket !== "asset" ||
        file.status !== "stored" ||
        file.moderationState === "block" ||
        !file.etag ||
        file.sizeBytes === null ||
        file.sizeBytes <= 0n,
    )
  )
    return null;
  const store = await deps.assets.readStore(tx, asset.storeId);
  const now = deps.clock.now();
  if (
    !store ||
    store.id !== asset.storeId ||
    store.entityId !== asset.entityId ||
    store.lifecycle !== "active" ||
    fresh.nextRunAt <= now ||
    fresh.deadlineAt <= now
  )
    return null;
  return { job: fresh, asset, files };
}

const factsEqual = (left: ModelBudgetFacts, right: ModelBudgetFacts) =>
  Object.keys(left).length === Object.keys(right).length &&
  Object.entries(left).every(([key, value]) =>
    key === "fileIds"
      ? JSON.stringify(value) === JSON.stringify(right.fileIds)
      : value === right[key as keyof ModelBudgetFacts],
  );
function checkedPermit(value: ModelBudgetContext | null, facts: ModelBudgetFacts) {
  if (value === null) return null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 13
  )
    throw new TypeError("模型许可格式非法");
  const { dailyFileCap, dailyCallCap, ...returned } = value;
  if (
    !factsEqual(facts, returned) ||
    !Number.isInteger(dailyFileCap) ||
    dailyFileCap < 1 ||
    dailyFileCap > 200 ||
    !Number.isInteger(dailyCallCap) ||
    dailyCallCap < 1 ||
    dailyCallCap > 10000
  )
    throw new TypeError("模型许可事实不匹配");
  return Object.freeze({
    ...facts,
    fileIds: Object.freeze([...facts.fileIds]),
    dailyFileCap,
    dailyCallCap,
  });
}

/** P1提交→PG外预留→P2提交；任何迟到/回滚只保守占槽，不退款、不重授窗口。 */
export async function admitModel(
  deps: AssetDeps,
  job: MediaJob,
  signal: AbortSignal,
  read: (tx: Tx) => Promise<ModelAdmissionSource | null>,
  expiresAtMs = Number.MAX_SAFE_INTEGER,
): Promise<JobOutcome | { readonly permit: ModelBudgetContext }> {
  const fresh = (facts: ModelBudgetFacts) => {
    const now = deps.clock.now().getTime();
    return (
      !signal.aborted && now >= facts.readAtMs && now < facts.admitUntilMs && now < expiresAtMs
    );
  };
  try {
    if (!completeModelBudget(deps)) return modelBudgetFailure("unavailable");
    if (
      (job.state !== "running" &&
        !(job.kind === "asr" && job.mode === "remote" && job.state === "submitting")) ||
      !["asr", "vision", "digest"].includes(job.kind)
    )
      return { state: "canceled" };
    const port = deps.assets.modelBudget!;
    const paid = await deps.tx.run(async (tx) => {
      const source = await read(tx);
      if (!source || signal.aborted) return undefined;
      const readAtMs = deps.clock.now().getTime();
      const facts: ModelBudgetFacts = Object.freeze({
        entityId: source.entityId,
        storeId: source.storeId,
        expectedSourceHash: source.expectedSourceHash,
        fileIds: Object.freeze([...source.fileIds]),
        jobId: job.id,
        kind: job.kind as ModelBudgetFacts["kind"],
        attemptNo: job.attemptNo,
        readAtMs,
        admitUntilMs: Math.min(
          readAtMs + 250,
          job.nextRunAt.getTime(),
          job.deadlineAt.getTime(),
          expiresAtMs,
        ),
        leaseUntilMs: job.nextRunAt.getTime(),
        originalDeadlineMs: job.deadlineAt.getTime(),
      });
      if (!fresh(facts)) return undefined;
      const permit = checkedPermit(await port.readPermit(tx, facts), facts);
      if (!fresh(facts)) return undefined;
      return permit;
    });
    if (paid === undefined) return { state: "canceled" };
    if (paid === null) return modelBudgetFailure("disabled");
    if (!fresh(paid)) return { state: "canceled" };
    assertNotInTransaction("模型预算预留");
    if (isInTransaction()) return modelBudgetFailure("unavailable");
    const decision: ModelBudgetDecision = await port.reserve(paid, signal);
    if (!fresh(paid)) return { state: "canceled" };
    if (
      decision?.status === "denied" &&
      Object.keys(decision).length === 2 &&
      ["disabled", "quota_global", "quota_store", "duplicate", "stale", "unavailable"].includes(
        decision.reason,
      )
    )
      return modelBudgetFailure(decision.reason);
    if (
      decision?.status !== "reserved" ||
      Object.keys(decision).length !== 3 ||
      decision.units !== (job.kind === "asr" ? 1 : 3) ||
      !Number.isInteger(decision.newFiles) ||
      decision.newFiles < 0 ||
      decision.newFiles > paid.fileIds.length
    )
      return modelBudgetFailure("unavailable");
    const ready = await deps.tx.run(async (tx) => {
      const source = await read(tx);
      if (!source || !fresh(paid)) return false;
      const { dailyFileCap, dailyCallCap, ...original } = paid;
      if (!factsEqual({ ...original, ...source }, original)) return false;
      const readAtMs = deps.clock.now().getTime();
      const permit = checkedPermit(
        await port.readPermit(tx, Object.freeze({ ...original, readAtMs })),
        { ...original, readAtMs },
      );
      return (
        !!permit &&
        permit.dailyFileCap === dailyFileCap &&
        permit.dailyCallCap === dailyCallCap &&
        fresh(paid)
      );
    });
    return ready && fresh(paid) ? { permit: paid } : { state: "canceled" };
  } catch {
    return signal.aborted ? { state: "canceled" } : modelBudgetFailure("unavailable");
  }
}
