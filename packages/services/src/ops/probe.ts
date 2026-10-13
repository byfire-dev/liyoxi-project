import { createPrismaClient } from "@liyoxi/db";
import type { AlertInput, Clock, Tx, TxRunner } from "../kernel/index.js";
import type { ProviderLogger } from "../providers/types.js";
import { writeAlertFact, writeHealthyProbeFact, writeUnknownProbeFact } from "./alert-facts.js";
import type { SqlRunner } from "./binding.js";
import type { ProbeRule } from "./probe-rules.js";

export const PROBE_INTERVAL_MS = 60_000;
export const PROBE_BUDGET_MS = 20_000;
export const PROBE_QUERY_MS = 2_000;
export const PROBE_CONCURRENCY = 3;

/** 专用读侧池，不占用续约连接；入口拥有并负责关闭。 */
export function connectProbeDatabase(connectionString: string) {
  const prisma = createPrismaClient({
    connectionString,
    max: PROBE_CONCURRENCY,
    statementTimeoutMs: PROBE_QUERY_MS,
    lockTimeoutMs: PROBE_QUERY_MS,
  });
  return { prisma, close: () => prisma.$disconnect() };
}
export interface ProbeResult {
  readonly completed: boolean;
  readonly samples: number;
  readonly failed: number;
  readonly elapsedMs: number;
}
interface Options {
  readonly db: SqlRunner;
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly holder: () => string | undefined;
  readonly rules: readonly ProbeRule[];
  readonly logger: ProviderLogger;
  /** 仅可缩短预算，供小量隔离验证。 */
  readonly budgetMs?: number;
  readonly queryMs?: number;
}
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export function createProbe(options: Options) {
  const budgetMs = Math.min(options.budgetMs ?? PROBE_BUDGET_MS, PROBE_BUDGET_MS);
  const queryMs = Math.min(options.queryMs ?? PROBE_QUERY_MS, PROBE_QUERY_MS);
  if (![budgetMs, queryMs].every((n) => Number.isInteger(n) && n > 0))
    throw new TypeError("探针预算非法");
  if (new Set(options.rules.map((rule) => rule.key)).size !== options.rules.length)
    throw new TypeError("探针名称重复");
  const lifetime = new AbortController(),
    failures = new Map<string, number>();
  const pending = new Set<Promise<unknown>>();
  let running: Promise<ProbeResult> | undefined, closing: Promise<void> | undefined;
  const track = <T>(p: Promise<T>): Promise<T> => {
    pending.add(p);
    void p.finally(() => pending.delete(p)).catch(() => undefined);
    return p;
  };
  async function round(beat?: () => void): Promise<ProbeResult> {
    const start = performance.now(),
      at = options.clock.now(),
      holder = options.holder();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, lifetime.signal]);
    const timer = setTimeout(() => controller.abort(new Error("探针预算耗尽")), budgetMs);
    let samples = 0,
      failed = 0,
      completed = false;
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (!holder || holder !== options.holder() || performance.now() - start >= budgetMs)
        throw new Error("探针已失去运行权");
    };
    const withLease = (fn: (tx: Tx) => Promise<void>) =>
      options.tx.run(
        async (tx) => {
          assertCurrent();
          const rows = await tx.$queryRawUnsafe<{ holder: string }[]>(
            `SELECT holder FROM worker_lease WHERE name='primary' AND holder=$1
         AND heartbeat_at >= clock_timestamp()-interval '30 second' FOR SHARE`,
            holder,
          );
          if (rows.length !== 1) throw new Error("探针主租约已失效");
          assertCurrent();
          await fn(tx);
          assertCurrent();
        },
        { timeoutMs: queryMs, maxWaitMs: queryMs },
      );
    async function execute() {
      assertCurrent();
      const held = await bounded(
        track(
          options.db.$queryRawUnsafe<{ holder: string }[]>(
            `SELECT holder FROM worker_lease WHERE name='primary' AND holder=$1
         AND heartbeat_at >= clock_timestamp()-interval '30 second'`,
            holder,
          ),
        ),
        AbortSignal.any([signal, AbortSignal.timeout(queryMs)]),
      );
      if (held.length !== 1) throw new Error("探针主租约已失效");
      let index = 0;
      const work = async () => {
        for (;;) {
          assertCurrent();
          const rule = options.rules[index++];
          if (!rule) return;
          let breaches: readonly AlertInput[] = [],
            healthy = false;
          try {
            breaches = await bounded(
              track(Promise.resolve().then(() => rule.sample(at))),
              AbortSignal.any([signal, AbortSignal.timeout(queryMs)]),
            );
            healthy = true;
          } catch {
            assertCurrent();
            failed++;
          }
          assertCurrent();
          const streak = healthy ? 0 : (failures.get(rule.key) ?? 0) + 1;
          await withLease(async (tx) => {
            const now = options.clock.now();
            if (!healthy) {
              if (streak >= 3)
                await writeAlertFact(
                  tx,
                  { rule: "probe.failed", dimension: rule.key, severity: "P2", detail: { streak } },
                  "probe",
                  now,
                  at,
                );
              for (const target of [{ rule: "probe.failed", dimension: rule.key }, ...rule.targets])
                await writeUnknownProbeFact(tx, target, now, at);
              return;
            }
            for (const input of breaches) await writeAlertFact(tx, input, "probe", now, at);
            for (const target of [{ rule: "probe.failed", dimension: rule.key }, ...rule.targets]) {
              if (!breaches.some((b) => b.rule === target.rule && b.dimension === target.dimension))
                await writeHealthyProbeFact(tx, target, now, at);
            }
          });
          failures.set(rule.key, streak);
          samples++;
          beat?.();
        }
      };
      await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, () => track(work())));
      await withLease(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE worker_lease SET probe_at=$2,updated_at=$2 WHERE name='primary' AND holder=$1`,
          holder,
          options.clock.now(),
        );
      });
      completed = true;
    }
    const execution = track(execute());
    try {
      await bounded(execution, signal);
    } catch {
      options.logger.error({ evt: "ops.probe_incomplete", samples, failed }, "探针轮次未完成");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    return { completed, samples, failed, elapsedMs: performance.now() - start };
  }
  return {
    run(beat?: () => void) {
      if (lifetime.signal.aborted) return Promise.reject(new Error("探针已关闭"));
      if (!running) {
        running = round(beat);
        // 超时后仍等底层查询退出才允许新轮；close同样收完这些有界读请求。
        void running
          .finally(async () => {
            await Promise.allSettled([...pending]);
            running = undefined;
          })
          .catch(() => undefined);
      }
      return running;
    },
    close() {
      lifetime.abort(new Error("探针关闭"));
      return (closing ??= Promise.allSettled([...(running ? [running] : []), ...pending]).then(
        () => undefined,
      ));
    },
  };
}
