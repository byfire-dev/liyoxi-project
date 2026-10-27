import type { Assembly, RecurringRunContext } from "../../kernel/index.js";
import type { RefundDeps } from "../refund/context.js";
import { STAGING_REFUND_JOB } from "./guards.js";
import { runStagingAutorefund } from "./jobs.js";

export async function unboundStagingAutorefundJob(): Promise<never> {
  throw new TypeError("预发自动退款运行时未绑定或已关闭");
}
/** 每实例独立绑定；非stg连实际run索引都没有该项，不能靠执行时if充当排除。 */
export function createStagingPayAssembly(base: Assembly) {
  let deps: RefundDeps | undefined,
    closed = false;
  const lifetime = new AbortController();
  const laggards = new Set<string>();
  const isStaging = base.appEnv === "stg";
  const run = isStaging
    ? (ctx: RecurringRunContext) => {
        if (closed || !deps) return unboundStagingAutorefundJob();
        if (!ctx.signal || !ctx.runTx) throw new TypeError("预发退款要求真实job运输");
        const signal = AbortSignal.any([ctx.signal, lifetime.signal]);
        return runStagingAutorefund(deps, { ...ctx, signal }, laggards);
      }
    : undefined;
  if (
    base.recurringJobs.filter((j) => j.kind === STAGING_REFUND_JOB).length !== (isStaging ? 1 : 0)
  )
    throw new TypeError("预发自动退款登记与当前环境不一致");
  const recurringJobs = base.recurringJobs.map((j) =>
    j.kind === STAGING_REFUND_JOB && run ? { ...j, run } : j,
  );
  const handlers = new Map(recurringJobs.map((j) => [j.kind, j]));
  const assembly: Assembly = { ...base, recurringJobs, recurringJob: (kind) => handlers.get(kind) };
  return {
    assembly,
    attach(value: RefundDeps) {
      if (closed || deps) throw new TypeError("预发退款运行时只能绑定一次");
      if (isStaging && value.stagingPay?.APP_ENV !== "stg")
        throw new TypeError("预发退款配置与装配环境不一致");
      deps = value;
    },
    close() {
      closed = true;
      lifetime.abort();
      deps = undefined;
      laggards.clear();
    },
  };
}
