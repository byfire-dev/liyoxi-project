import { calendarDate } from "@liyoxi/shared/time";
import type { RecurringRunContext } from "../../kernel/index.js";
import { lockRows, SessionMutexError } from "../../kernel/index.js";
import { release } from "../refs.js";
import {
  expireUploads,
  cleanIncoming,
  repairPurgeCache,
  expireBatches,
  purgeOcrRaw,
} from "./maintenance.js";
import { preparePurgeRun } from "./purge-runs.js";
import { executePurgeRun } from "./purge-execute.js";
import { sweepContext, SWEEP_BATCH } from "./sweep-context.js";
import type { RetentionDeps } from "./types.js";
import { releaseArchivedAssets } from "./archive-assets.js";

export function createMediaSweep(deps: RetentionDeps) {
  let proofAfter: string | undefined,
    demandAfter: string | undefined,
    assetAfter: string | undefined;
  return async (context: RecurringRunContext) => {
    const ctx = sweepContext(deps, context),
      result: Record<string, unknown> = {},
      failed: string[] = [];
    const step = async (name: string, run: () => Promise<unknown>) => {
      ctx.signal.throwIfAborted();
      try {
        result[name] = await run();
      } catch (error) {
        ctx.signal.throwIfAborted();
        if (
          error instanceof SessionMutexError &&
          ["lost", "closed", "released"].includes(error.reason)
        )
          throw error;
        failed.push(name);
        await deps
          .retention!.alerts.raise({
            rule: "media.sweep_failed",
            dimension: name,
            severity: "P2",
            detail: { step: name },
          })
          .catch(() => undefined);
      }
    };
    await step("uploads", () => expireUploads(ctx));
    await step("incoming", () => cleanIncoming(ctx));
    // 注销/主体关闭法定3年证明仅复用拥有者canRelease及既有release；不泛化其他证照缓冲。
    await step("accountProofs", () =>
      ctx.transaction("account-proofs", async (tx) => {
        const rule = deps.refTypes.get("account_change_request")?.roles.proof;
        if (!rule?.canRelease) throw new TypeError("账号证明释放规则未装配");
        const refs = await tx.fileRef.findMany({
          where: {
            refType: "account_change_request",
            role: "proof",
            state: "live",
            ...(proofAfter ? { id: { gt: proofAfter } } : {}),
          },
          orderBy: { id: "asc" },
          take: SWEEP_BATCH,
        });
        const eligible = [];
        for (const ref of refs) if (await rule.canRelease(tx, ref.refId)) eligible.push(ref);
        await lockRows(tx, "file_object", [...new Set(eligible.map((ref) => ref.fileId))].sort());
        for (const ref of eligible) {
          const file = await tx.fileObject.findUniqueOrThrow({ where: { id: ref.fileId } });
          await release(ctx.deps, tx, {
            fileId: ref.fileId,
            refType: ref.refType,
            refId: ref.refId,
            role: ref.role,
            entityId: file.entityId,
            storeId: file.storeId,
            keepUntil: deps.clock.now(),
          });
        }
        proofAfter = refs.length === SWEEP_BATCH ? refs.at(-1)!.id : undefined;
        return eligible.length;
      }),
    );
    await step("archivedAssets", async () => {
      const result = await releaseArchivedAssets(ctx, assetAfter);
      assetAfter = result.after;
      return result.released;
    });
    await step("purgeCache", () =>
      ctx.transaction(
        "purge-cache",
        async (tx) => (await repairPurgeCache(tx, deps.clock.now())).length,
      ),
    );
    await step("batches", () => expireBatches(ctx));
    await step("purge", async () => {
      const runId = await preparePurgeRun(ctx);
      return runId ? executePurgeRun(ctx, runId) : null;
    });
    await step("ocr", () => purgeOcrRaw(ctx));
    await step("demands", () =>
      ctx.transaction("demands", async (tx) => {
        const day = new Date(`${calendarDate(deps.clock.now())}T00:00:00.000Z`);
        const rows = await tx.storeAssetDemand.findMany({
          where: {
            status: "open",
            dueDate: { lte: day },
            ...(demandAfter ? { id: { gt: demandAfter } } : {}),
          },
          orderBy: { id: "asc" },
          take: SWEEP_BATCH,
          select: { id: true },
        });
        let made = 0;
        for (const row of rows) {
          ctx.signal.throwIfAborted();
          made += await deps.retention!.sweep!.remindDemand(tx, row.id);
        }
        demandAfter = rows.length === SWEEP_BATCH ? rows.at(-1)!.id : undefined;
        return made;
      }),
    );
    return { ...result, failed };
  };
}
