import type { Assembly, Clock, RecurringRunContext, TxRunner } from "../kernel/index.js";
import type { StorageProvider } from "../providers/types.js";
import { writeAlertFact } from "./alert-facts.js";
import { createBackup, readBackupSummary } from "./backup.js";
import type { BackupConfig, BackupProcessRunner } from "./backup.js";

export async function unboundBackupJob(): Promise<never> {
  throw new TypeError("备份运行时尚未装配");
}
export function createBackupAssembly(
  base: Assembly,
  deps: {
    readonly tx: TxRunner;
    readonly clock: Clock;
    readonly config?: BackupConfig;
    readonly storage: () => StorageProvider;
    readonly processRunner?: BackupProcessRunner;
  },
) {
  const backup = createBackup(deps),
    lifetime = new AbortController(),
    pending = new Set<Promise<unknown>>();
  let closed = false,
    closing: Promise<void> | undefined;
  const execute = async (ctx: RecurringRunContext) => {
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, lifetime.signal]) : lifetime.signal;
    const runTx = ctx.runTx ?? deps.tx.run.bind(deps.tx);
    try {
      signal.throwIfAborted();
      const previousBytes = await runTx(async (tx) => {
        signal.throwIfAborted();
        const row = await tx.timer.findFirst({
          where: {
            kind: "backup.pgdump",
            status: "fired",
            subjectType: null,
            subjectId: null,
            fireAt: { lt: ctx.scheduledFor },
          },
          select: { result: true },
          orderBy: [{ fireAt: "desc" }, { id: "desc" }],
        });
        signal.throwIfAborted();
        if (!row) return undefined;
        const result = readBackupSummary(row.result);
        if (!result) throw new Error("最近成功备份的摘要不合法");
        return result.bytes;
      });
      signal.throwIfAborted();
      const result = await backup.run({ scheduledFor: ctx.scheduledFor, signal, previousBytes });
      signal.throwIfAborted();
      return { ...result };
    } catch {
      // 取消/失租不另开后继事务；任务行状态/重试仍由原定时器处理。
      try {
        signal.throwIfAborted();
        await runTx(async (tx) => {
          signal.throwIfAborted();
          await writeAlertFact(
            tx,
            {
              rule: "backup.failed",
              severity: "P1",
              detail: { reason: deps.config ? "failed" : "unconfigured" },
            },
            "event",
            deps.clock.now(),
            ctx.scheduledFor,
          );
          signal.throwIfAborted();
        });
      } catch {
        // 告警写入失败也拒绝任务，原始驱动或取消信息不进入 timer.lastError。
      }
      throw new Error("备份任务失败或已取消");
    }
  };
  const run = (ctx: RecurringRunContext) => {
    if (closed) throw new TypeError("备份运行时已经关闭");
    const active = execute(ctx);
    pending.add(active);
    void active.finally(() => pending.delete(active)).catch(() => undefined);
    return active;
  };
  const recurringJobs = base.recurringJobs.map((item) =>
      item.kind === "backup.pgdump" ? { ...item, run } : item,
    ),
    index = new Map(recurringJobs.map((item) => [item.kind, item]));
  return {
    assembly: {
      ...base,
      recurringJobs,
      recurringJob: (kind: string) => index.get(kind),
    } satisfies Assembly,
    close() {
      closed = true;
      lifetime.abort();
      return (closing ??= Promise.allSettled([...pending]).then(() => undefined));
    },
  };
}
