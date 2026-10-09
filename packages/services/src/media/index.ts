export { createMedia } from "./runtime.js";
export type { Media } from "./runtime.js";
export type {
  MediaActor,
  MediaDeps,
  DeliveryDownloadSignInput,
  RegisterInput,
  LinkInput,
  ReleaseInput,
  SystemFileInput,
} from "./context.js";
export { fileCategoryGuardPort, fileRefTypePort } from "./ports.js";
export type { FileCategoryGuard, FileRefType, ExpectedFileRef } from "./ports.js";
export { findI2Violations, findI14Violations } from "./invariants.js";
export type { PromoteRef } from "./promote.js";
export { registration } from "./register.js";
export type { MediaBatchDeps, BatchTargetFacts } from "./batches/types.js";

export { seedPlaceholderFiles, placeholderPdf } from "./demo-seed.js";
export { declareManualProduction, ensureProductionStubs } from "./production-stub.js";
export type { ManualProductionInput } from "./production-stub.js";
export { consumeFinalReleaseBatch, recordAdoptedStoreAssets } from "./delivery-write.js";
export type { FinalBatchItem, MediaDeliveryTarget } from "./delivery-write.js";

export type { WechatImageResultInput } from "./wechat-image-audit.js";

export { createMediaJobs } from "./jobs/runner.js";
export { createRemoteMediaHandler } from "./jobs/remote.js";
export { MEDIA_JOB_BUDGETS, jobBudget, MEDIA_SCAN_INTERVAL_MS } from "./jobs/policy.js";
export type {
  MediaJobHandler,
  MediaConvergenceHandler,
  JobOutcome,
  MediaJobsOptions,
} from "./jobs/types.js";
export type { RemoteMediaHandlerOptions, RemoteMediaSubmission } from "./jobs/remote.js";

export type { MediaJobs } from "./jobs/runner.js";
export { findI10Violations, findI11Violations } from "./jobs/invariants.js";
export { decideMediaConvergence, systemProduceId } from "./jobs/convergence.js";
