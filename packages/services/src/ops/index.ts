// ops：任务进程的租约与服务装配（W0-23）。不变量与清理的调度在本文件末尾（W0-24）；探针、告警在 G2-D。
export { createWorkerLease, LEASE_DOWN_SEC, LEASE_RENEW_MS, LEASE_TAKEOVER_SEC } from "./lease.js";
export type { WorkerLease, WorkerLeaseOptions } from "./lease.js";
export { buildWorkerServices, connectWorkerDatabase } from "./worker.js";
export { connectProbeDatabase, createProbe, PROBE_INTERVAL_MS } from "./probe.js";
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
// W0-24：不变量校验的运行与落库、违规上报端口的实现、清理的执行，三个周期任务登记在 register.ts
export { bindOps, boundOps } from "./binding.js";
export type { OpsBinding, SqlRunner } from "./binding.js";
export * from "./invariants/index.js";
export {
  isFirstRoundOfDay,
  RETENTION_LIMIT,
  RETENTION_MAX_BATCHES,
  runRetention,
} from "./retention.js";
export type { RetentionDeps, RetentionInput, RetentionResult } from "./retention.js";
export { registration } from "./register.js";
export { createBackupAssembly, unboundBackupJob } from "./backup-runtime.js";
export { readBackupSummary } from "./backup.js";
export type { BackupChild, BackupProcessRunner, BackupSummary } from "./backup.js";
export { backupProbeRules, BACKUP_STALE_MS } from "./backup-probe-rules.js";
export { createAlertDispatcher, DEFAULT_P2_IMMEDIATE } from "./alert-delivery.js";
export type { AlertDispatcherOptions } from "./alert-delivery.js";
// KF-1 启动自检：两个进程共用的清单与运行器（runStartupChecks 原在 runtime.ts，挪到这里，那边照旧转导出）
export { createStartupChecks, runStartupChecks, StartupCheckError } from "./startup.js";
export type { StartupCheck, StartupCheckDeps } from "./startup.js";
export {
  createClientErrorForwarder,
  CLIENT_ERROR_MAX_BYTES,
  CLIENT_ERROR_QUEUE_SIZE,
} from "./client-errors.js";
export type {
  ClientErrorProject,
  ClientErrorLogger,
  ClientErrorForwarderOptions,
  ClientErrorSnapshot,
  ClientErrorForwarder,
} from "./client-errors.js";
export {
  createServerErrorReporter,
  drainServerErrors,
  installServerErrorHandlers,
} from "./server-errors.js";
export type { ServerErrorKind, ServerErrorOptions, ServerErrorReporter } from "./server-errors.js";
export { createFlowOps, assertFlowOpsRead } from "./flow-ops.js";
export type { FlowOps, FlowOpsActor, FlowOpsDeps } from "./flow-ops.js";
export { createAlertActions } from "./alert-actions.js";
export type {
  AlertActions,
  AlertCliCommand,
  AlertCliInput,
  AlertCliResult,
} from "./alert-actions.js";

export { createNotifyAssembly, createRuntimeNotify } from "./notify-runtime.js";

export { createMediaAssembly, mediaSweepOptions } from "./media-runtime.js";
export { createRuntimeMediaBatches } from "./media-batches-runtime.js";
export { createRuntimeMediaProduction } from "./media-production-runtime.js";

export { createDocsAssembly, createRuntimeDocs } from "./docs-runtime.js";
export { createAlertFacts } from "./alert-facts.js";
export { createBillMissingObserver } from "./bill-missing.js";
export type { AlertFacts, AlertFactsDeps } from "./alert-facts.js";
export { createAlertFactsAssembly } from "./alert-facts-runtime.js";

export { createContentPricingAssembly } from "./content-pricing-runtime.js";

export { createContentAdmin } from "./content-admin.js";
export type { ContentAdmin, ContentAdminActor } from "./content-admin.js";

export { createDeliveryProductionAssembly } from "./delivery-production-runtime.js";
export { createDeliverySlaAssembly } from "./delivery-sla-runtime.js";
export {
  parseDemoMasterArgs,
  readDemoMasterInput,
  createDemoMasterInputPreparer,
} from "./demo-masters-input.js";

export { createRuntimeMediaAssets, createMediaAssetsAssembly } from "./media-assets-runtime.js";
export { readModelBudgetPermit } from "./model-budget-permit.js";
export { readStoreDraftFacts } from "./store-draft-facts.js";
export { createModelBudgetRuntime } from "./model-budget-runtime.js";
export { createModelBudgetInspector } from "./model-budget-inspect.js";
export type { ModelBudgetInspection } from "./model-budget-inspect.js";
export { createModelBudgetInitializer } from "./model-budget-initialize.js";
export type { ModelBudgetInitialization } from "./model-budget-initialize.js";
export { createProfileLifecycleAssembly } from "./profile-lifecycle-runtime.js";
export { createInvitationAssembly } from "./invitation-runtime.js";

export {
  createTenantEntitlementAssembly,
  createRuntimeTenantEntitlement,
} from "./tenant-entitlement-runtime.js";
