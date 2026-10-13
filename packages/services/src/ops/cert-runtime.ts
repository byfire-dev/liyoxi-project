import type { Assembly, Clock, RecurringRunContext, TxRunner } from "../kernel/index.js";
import { writeAlertFact, writeHealthyProbeFact } from "./alert-facts.js";
import { createCertChecker } from "./cert.js";
import type { TlsCertificateProbe } from "./cert.js";

/** 静态登记从不保存进程实例；worker装配会以自己的闭包替换本处理器。 */
export async function unboundCertJob(): Promise<never> {
  throw new TypeError("证书运行时尚未装配");
}

export function createCertAssembly(
  base: Assembly,
  deps: {
    readonly tx: TxRunner;
    readonly clock: Clock;
    readonly domains: readonly string[];
    readonly probe?: TlsCertificateProbe;
    readonly timeoutMs?: number;
  },
) {
  const checker = createCertChecker(deps);
  const lifetime = new AbortController();
  let closed = false,
    closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const execute = async (ctx: RecurringRunContext) => {
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, lifetime.signal]) : lifetime.signal;
    signal.throwIfAborted();
    const result = await checker.run({ signal });
    signal.throwIfAborted();
    const runTx = ctx.runTx ?? deps.tx.run.bind(deps.tx);
    if (!result.configured) {
      await runTx(async (tx) => {
        signal.throwIfAborted();
        await writeAlertFact(
          tx,
          { rule: "cert.unconfigured", severity: "P3", detail: { configured: false } },
          "event",
          deps.clock.now(),
          ctx.scheduledFor,
        );
        signal.throwIfAborted();
      });
      return { status: "unconfigured", configured: false, domains: 0 };
    }
    for (const item of result.certificates) {
      signal.throwIfAborted();
      // 复用调度器短事务入口，写前/提交前重核取消；直接调用用本实例runner。
      await runTx(async (tx) => {
        signal.throwIfAborted();
        const input = { rule: "cert.expiry", dimension: item.domain };
        if (item.priority)
          await writeAlertFact(
            tx,
            {
              ...input,
              severity: item.priority,
              detail: { remainingDays: item.remainingDays ?? null, status: item.status },
            },
            "probe",
            deps.clock.now(),
            ctx.scheduledFor,
          );
        else await writeHealthyProbeFact(tx, input, deps.clock.now(), ctx.scheduledFor);
        signal.throwIfAborted();
      });
    }
    return {
      status: result.certificates.every((item) => item.status === "healthy")
        ? "healthy"
        : "degraded",
      configured: true,
      results: result.certificates,
    };
  };
  const run = (ctx: RecurringRunContext) => {
    if (closed) throw new TypeError("证书运行时已经关闭");
    const active = execute(ctx);
    pending.add(active);
    void active.finally(() => pending.delete(active)).catch(() => undefined);
    return active;
  };
  const recurringJobs = base.recurringJobs.map((item) =>
    item.kind === "ops.cert_check" ? { ...item, run } : item,
  );
  const index = new Map(recurringJobs.map((item) => [item.kind, item]));
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
