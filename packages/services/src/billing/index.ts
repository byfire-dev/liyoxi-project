// W0-21 种子：套餐与首版价目、积分包、等级模板价、计费参数、估值口径
export { seed } from "./seed.js";
export { createPlanAdmin, planActivityCounts } from "./catalog/plans-admin.js";
export type { PlanAdminActor } from "./catalog/plans-admin.js";
export { createParameterChanges } from "./pricing/parameter-changes.js";
export {
  BILLING_PARAM_SEEDS,
  cyclePricesOf,
  INITIAL_CYCLES,
  PLAN_SEEDS,
  POINT_PACK_SEEDS,
  PRICE_TIER_SEEDS,
  VALUATION_POLICY_SEED,
} from "./seed-data.js";
export type { PlanSeed } from "./seed-data.js";
// W1-10 账本内核（账户与批次）：createLedger 给出 tx 在前的账本函数；读函数显式收时刻；每分钟扫描的用例函数；不变量
export {
  ACCOUNT_LOCK_WAIT_MS,
  ADVANCE_JOB,
  createLedger,
  LEDGER_STEPS,
  LedgerError,
} from "./ledger/index.js";
export type {
  AcquireOptions,
  AdvanceSummary,
  Db as BillingDb,
  GrantInput,
  GrantResult,
  Ledger,
  LedgerClock,
  LedgerDeps,
  LedgerRefusal,
  LedgerStep,
  PurchaseInput,
  PurchaseResult,
} from "./ledger/index.js";
export { paramsAt, priceAt } from "./pricing/index.js";
export type { DramaPrice, PriceUnavailable } from "./pricing/index.js";
export { getEntitlements, getWalletView, listOperationsByHold } from "./read/index.js";
export type {
  EntitlementTerm,
  Entitlements,
  LedgerOperationView,
  SubscriptionStatus,
  TermBenefits,
  WalletView,
} from "./read/index.js";
export { ADVANCE_SWEEP_LIMIT, advanceDueAccounts } from "./sweep.js";
export type { AdvanceSweepDeps, AdvanceSweepOptions, AdvanceSweepResult } from "./sweep.js";
export { billingInvariants } from "./invariants.js";
export { registration } from "./register.js";
// W1-10 第二个 PR：冻结单一族（hold、capture、charge、release、refund）、调整、加购恢复都在 createLedger 给出的账本上；
// 这里补它们的入参与结果类型、冻结单状态不符的领域错误、应扣积分与计价快照的函数（报价接口与锁内重算同一份）
export { HoldStateError } from "./ledger/index.js";
export type {
  AdjustInput,
  AdjustResult,
  CaptureInput,
  CaptureResult,
  HoldInput,
  HoldRefType,
  HoldResult,
  HoldStatus,
  RefundInput,
  ReleaseInput,
  ResumeAddonInput,
  ResumeAddonResult,
  ReturnReasonClass,
  ReturnResult,
} from "./ledger/index.js";
export { quoteHold } from "./pricing/quote.js";
export { previewReturn } from "./ledger/index.js";
export { readCancelHoldFacts } from "./ledger/index.js";
export type { CancelHoldFacts } from "./ledger/index.js";
export type { ReturnPreview } from "./ledger/index.js";
export type { HoldPricing, QuoteTerm } from "./pricing/quote.js";
// W1-11a（账本侧）：付清后的履约 createFulfillment（建周期与发放计划、发首月）；两个端口的实现；订阅一侧的三条不变量
export {
  blockedResult,
  createFulfillment,
  FULFILL_STEPS,
  FulfillBlockedError,
  fulfillOpKey,
  isNotBlockage,
  subscriptionInvariants,
} from "./subscription/index.js";
export type {
  FulfillDeps,
  Fulfillment,
  FulfillInput,
  FulfillOutcome,
  FulfillStep,
} from "./subscription/index.js";
export { billingAccountOpener, billingMerchantFacts, openAccountForEntity } from "./ports.js";
export { deletionGuard } from "./read/deletion-guard.js";
export { readBillingHistoryFacts } from "./read/history-facts.js";
export { readTenantAdminBillingFacts } from "./read/tenant-admin.js";
export type { TenantAdminBillingFacts } from "./read/tenant-admin.js";
export type { BillingDeletionGuardCounts } from "./read/deletion-guard.js";
export {
  createPayment,
  openPaymentException,
  APPLY_STEPS,
  recordChannelSuccess,
  paymentInvariants,
} from "./payment/index.js";
export type {
  Payment,
  PaymentDeps,
  ApplyPaymentInput,
  ApplyPaymentOutcome,
  ApplyPaymentResult,
  ApplyStep,
  PaymentExceptionKind,
} from "./payment/index.js";
export { createBillingPurchase } from "./payment/purchase.js";
export { createPointPacks } from "./catalog/point-packs.js";
export type { PointPackActor } from "./catalog/point-packs.js";
export type { BillingPurchase, BillingPurchaseDeps, PurchaseActor } from "./payment/purchase.js";
export {
  bindBillingTimers,
  handleTransferTtl,
  purchaseInvariants,
} from "./payment/purchase-registration.js";
export {
  financeConfigAt,
  proposeFinanceConfig,
  financeConfigApproval,
} from "./finance-config/index.js";
export { seedPlaceholderFinanceConfig, PLACEHOLDER_FINANCE } from "./demo-seed.js";
export type { BillingSeedDeps } from "./demo-seed.js";
export { getNotifyPurchaseMode, getPurchasePolicy } from "./policy/index.js";

export { billingPiiFields } from "./pii-fields.js";

export { createDramaPricing } from "./pricing/revisions.js";
export type { DramaPricingService, DramaPricingDeps } from "./pricing/revisions.js";

export { createWechatChannel } from "./payment/wechat-channel.js";
export { createWechatPaymentSource } from "./payment/channel-webhook.js";
export { bindPaymentChannel } from "./payment/channel-registration.js";
export { captureSubscriptionDailySnapshot } from "./reporting/snapshot.js";
export { rebuildEntityValuation } from "./reporting/valuation.js";
export {
  BillingDailyHistoryMissingError,
  createBillingDailyProjection,
} from "./reporting/daily.js";
