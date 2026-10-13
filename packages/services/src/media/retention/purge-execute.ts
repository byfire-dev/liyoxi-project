import {
  AppError,
  createActor,
  createIdempotencyContext,
  createThreePhaseRunner,
  lockRows,
  SessionMutexError,
} from "../../kernel/index.js";
import type { ObjectRef } from "../../providers/types.js";
import { purgeAfter, sweepGuard } from "./current-refs.js";
import { afterPurged } from "./hooks.js";
import { lockRun } from "./purge-runs.js";
import { fileMutexKey } from "./types.js";
import { SWEEP_BATCH } from "./sweep-context.js";
import type { SweepContext } from "./sweep-context.js";

class PurgeGuard extends Error {}
async function recordGuard(ctx: SweepContext, runId: string, fileId: string) {
  return ctx.tx.run(async (tx) => {
    const run = await lockRun(tx, runId);
    if (run.state !== "running") return;
    await lockRows(tx, "file_object", [fileId]);
    const file = await tx.fileObject.findUnique({ where: { id: fileId } });
    if (file?.status === "stored") {
      const expected = await purgeAfter(tx, file);
      // 当前独立业务引用漏记时禁止继续候选；I14仍报告漏记，不能造live引用。
      await tx.fileObject.update({
        where: { id: fileId },
        data: {
          purgeAfter: expected && expected <= ctx.deps.clock.now() ? null : expected,
          updatedAt: ctx.deps.clock.now(),
        },
      });
    }
    const guardTrips = (run.guardTrips ?? 0) + 1,
      now = ctx.deps.clock.now();
    await tx.filePurgeRun.update({
      where: { id: run.id },
      data: {
        guardTrips,
        ...(guardTrips >= 3 ? { state: "aborted", finishedAt: now } : {}),
        updatedAt: now,
      },
    });
  });
}
/** 公开三段式记录区分本运行的未知soft-delete与手工erase；不读幂等私表。 */
async function purgeFile(ctx: SweepContext, runId: string, fileId: string) {
  const retention = ctx.deps.retention!;
  return retention.sessionMutex.run(
    fileMutexKey(fileId),
    async (scope) => {
      let attempted: ObjectRef | undefined;
      try {
        const result = await createThreePhaseRunner(ctx.deps).run(
          {
            claim: async (tx, { resumed }) => {
              const run = await lockRun(tx, runId);
              if (run.state !== "running" || !run.candidateIds.includes(fileId))
                throw new PurgeGuard("运行已结束或候选不符");
              await lockRows(tx, "file_object", [fileId]);
              const file = await tx.fileObject.findUnique({ where: { id: fileId } });
              if (!file || !(await sweepGuard(ctx.deps, tx, file, resumed)))
                throw new PurgeGuard("删除前当前事实不再满足");
              if (file.status === "stored")
                await tx.fileObject.update({
                  where: { id: fileId },
                  data: { status: "deleting", updatedAt: ctx.deps.clock.now() },
                });
              return { bucket: file.bucket as ObjectRef["bucket"], key: file.objectKey };
            },
            external: async (ref) => {
              await scope.assertHeld();
              attempted = ref;
              const result = await ctx.deps.storage.delete({ ...ref, signal: scope.signal });
              if (!result.ok) throw new Error("清除marker结果未知，保留本次意图待续作");
              await scope.assertHeld();
            },
            settle: async (tx) => {
              const run = await lockRun(tx, runId);
              await lockRows(tx, "file_object", [fileId]);
              const file = await tx.fileObject.findUniqueOrThrow({ where: { id: fileId } });
              if (run.state !== "running" || !(await sweepGuard(ctx.deps, tx, file, true)))
                throw new PurgeGuard("marker后当前事实复核失败，保持deleting并告警");
              const now = ctx.deps.clock.now();
              await tx.fileObject.update({
                where: { id: fileId },
                data: { status: "deleted", deletedAt: now, updatedAt: now },
              });
              await tx.filePurgeRun.update({
                where: { id: run.id },
                data: { deletedCount: { increment: 1 }, updatedAt: now },
              });
              return { fileId };
            },
          },
          {
            idem: createIdempotencyContext({
              mode: "required",
              scope: "media.sweep.purge",
              actor: createActor({ type: "system", job: "media.sweep" }),
              key: `${runId}:${fileId}`,
              request: { method: "POST", body: { runId, fileId } },
            }),
          },
        );
        await afterPurged(ctx.deps, result.fileId);
        return true;
      } catch (error) {
        if (!(error instanceof PurgeGuard)) throw error;
        if (attempted) {
          // marker之后独立业务事实变化：同file互斥内恢复对象，真实HEAD成功才回stored。
          await scope.assertHeld();
          const restored = await ctx.deps.storage.restoreVersions({
            ...attempted,
            signal: scope.signal,
          });
          if (restored.ok)
            await ctx.tx.run(async (tx) => {
              await lockRows(tx, "file_object", [fileId]);
              await tx.fileObject.updateMany({
                where: { id: fileId, status: "deleting", erasedAt: null },
                data: { status: "stored", purgeAfter: null, updatedAt: ctx.deps.clock.now() },
              });
            });
          else
            await retention.alerts.raise({
              rule: "purge.compensation_failed",
              dimension: fileId,
              severity: "P1",
              detail: { runId, fileId },
            });
        }
        await recordGuard(ctx, runId, fileId);
        await retention.alerts.raise({
          rule: "purge.guard_trip",
          dimension: runId,
          severity: "P2",
          detail: { runId, fileId },
        });
        return false;
      }
    },
    { signal: ctx.signal },
  );
}
export async function executePurgeRun(ctx: SweepContext, runId: string) {
  const ids = await ctx.tx.run(async (tx) => {
    const run = await tx.filePurgeRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.state !== "running") return [];
    return (
      await tx.fileObject.findMany({
        where: {
          id: { in: run.candidateIds },
          OR: [
            { status: "stored", purgeAfter: { lte: ctx.deps.clock.now() } },
            { status: "deleting" },
          ],
        },
        orderBy: { id: "asc" },
        take: SWEEP_BATCH,
        select: { id: true },
      })
    ).map((row) => row.id);
  });
  let deleted = 0,
    failed = 0;
  for (const id of ids) {
    ctx.signal.throwIfAborted();
    const running = await ctx.tx.run((tx) =>
      tx.filePurgeRun.findFirst({ where: { id: runId, state: "running" }, select: { id: true } }),
    );
    if (!running) break;
    try {
      if (await purgeFile(ctx, runId, id)) deleted++;
    } catch (error) {
      ctx.signal.throwIfAborted();
      if (
        error instanceof SessionMutexError &&
        ["closed", "lost", "released"].includes(error.reason)
      )
        throw error;
      if (!(error instanceof AppError && error.error === "IDEMPOTENCY_IN_PROGRESS")) {
        failed++;
        await ctx.deps.retention!.alerts.raise({
          rule: "purge.file_failed",
          dimension: id,
          severity: "P2",
          detail: { runId, fileId: id },
        });
      }
    }
  }
  await ctx.transaction("run", async (tx) => {
    const run = await lockRun(tx, runId);
    if (run.state !== "running") return;
    const remaining = await tx.fileObject.count({
      where: {
        id: { in: run.candidateIds },
        OR: [
          { status: "stored", purgeAfter: { lte: ctx.deps.clock.now() } },
          { status: "deleting" },
        ],
      },
    });
    if (!remaining)
      await tx.filePurgeRun.update({
        where: { id: runId },
        data: { state: "done", finishedAt: ctx.deps.clock.now(), updatedAt: ctx.deps.clock.now() },
      });
  });
  return { runId, deleted, failed };
}
