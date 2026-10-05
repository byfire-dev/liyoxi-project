// ops：任务进程的租约与服务装配（W0-23）。探针、告警、不变量与清理的调度在 G2-D、W0-24。
export { createWorkerLease, LEASE_DOWN_SEC, LEASE_RENEW_MS, LEASE_TAKEOVER_SEC } from "./lease.js";
export type { WorkerLease, WorkerLeaseOptions } from "./lease.js";
export { buildWorkerServices, connectWorkerDatabase } from "./worker.js";
export type { WorkerServices, WorkerServicesOptions } from "./worker.js";
// ops 模块（L4）的出口。W0-22 交付健康检查的取数；租约、探针、告警、不变量的调度随 W0-23、W0-24、W0-25。
export {
  createHealth,
  FLOW_P1,
  HEALTH_CACHE_MS,
  HEALTH_PROBE_TIMEOUT_MS,
  PROBE_MAX_AGE_SEC,
  WORKER_HEARTBEAT_MAX_AGE_SEC,
} from "./health.js";
export type {
  FinanceHealth,
  FlowHealth,
  Health,
  HealthOptions,
  HealthSummary,
  OkDegraded,
  UpDown,
} from "./health.js";
