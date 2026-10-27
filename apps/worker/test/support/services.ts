import { buildWorkerServices, createTimers } from "@liyoxi/services";
import type { WorkerServices, WorkerServicesOptions } from "@liyoxi/services";
import { assembleForTest } from "@liyoxi/services/testing";

const isRequiredRecurring = (job: { readonly kind: string }): boolean =>
  job.kind === "bill.download" ||
  job.kind === "receipt.daily_digest" ||
  job.kind === "stg.pay.autorefund";

/** 仅旧 worker 样例/媒体夹具：保留 omitReal 的调度边界，真实周期专项不走此投影。 */
export function buildWorkerServicesForTest(options: WorkerServicesOptions): WorkerServices {
  // 已带任一正式登记就原样交给生产装配，缺项/重项仍由原守卫拒绝。
  if (options.assembly.recurringJobs.some(isRequiredRecurring)) return buildWorkerServices(options);
  const real = assembleForTest({
    entry: options.assembly.entry,
    appEnv: options.assembly.appEnv,
  });
  // 按真实装配环境取登记：仅stg含自动退款，不能为非stg补出该项。
  const requiredJobs = real.recurringJobs.filter(isRequiredRecurring);
  const injectedKinds = new Set(requiredJobs.map((job) => job.kind));
  const recurringJobs = [...options.assembly.recurringJobs, ...requiredJobs];
  const services = buildWorkerServices({
    ...options,
    assembly: {
      ...options.assembly,
      recurringJobs,
      recurringJob: (kind) => recurringJobs.find((job) => job.kind === kind),
    },
  });
  const requestedJobs = services.assembly.recurringJobs.filter(
    (job) => !injectedKinds.has(job.kind),
  );
  // 同实例投影，保留 timing 的 assembly/registry 引用；scan/runTimer 不会读到另一份全量表。
  Object.assign(services.assembly, {
    recurringJobs: requestedJobs,
    recurringJob: (kind: string) => requestedJobs.find((job) => job.kind === kind),
  });
  const timers = createTimers({ assembly: services.assembly, catalog: options.timerCatalog });
  Object.assign(services.timers.registry, timers.registry);
  // ensureRecurring 的原闭包继续使用原 tx/clock，动态调用同一 timers 对象上的新方法。
  services.timers.ensureRecurring = timers.ensureRecurring;
  return services;
}
