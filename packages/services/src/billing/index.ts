// W0-21 种子：套餐与首版价目、积分包、等级模板价、计费参数、估值口径
export { seed } from "./seed.js";
export { createReconciliation } from "./reconciliation/index.js";
export type { Reconciliation, ReconciliationDeps } from "./reconciliation/index.js";
export { createReconciliationAssembly } from "./reconciliation/assembly.js";
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
  ApplyExtensionInput,
  ApplyExtensionResult,
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
export {
  ADVANCE_SWEEP_LIMIT,
  advanceDueAccounts,
  createBillingDailyAssembly,
  sweepSubscriptionDaily,
} from "./sweep.js";
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
export { describePaymentOrders } from "./payment/describe.js";
export type { PaymentOrderDescription } from "./payment/describe.js";
export { createPointPacks } from "./catalog/point-packs.js";
export { createBillingSubscriptions } from "./subscription/read.js";
export { listTermsDueForReminder } from "./subscription/reminders.js";
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
export { wechatOrderAttach } from "./payment/channel-success.js";
export { createTransferReviewAssembly } from "./payment/transfer-review.js";
export { captureSubscriptionDailySnapshot } from "./reporting/snapshot.js";
export { computeEntityValuation, rebuildEntityValuation } from "./reporting/valuation.js";
export type { BillingValuationReader } from "./reporting/valuation.js";
export {
  BillingDailyHistoryMissingError,
  computeEntityDaily,
  createBillingDailyProjection,
} from "./reporting/daily.js";
export type { BillingDailyReader, EntityDailyComputation } from "./reporting/daily.js";

export { createInvoices } from "./invoices/service.js";
export { createInvoiceAssembly } from "./invoices/assembly.js";
export { readInvoiceMail } from "./invoices/mail.js";
export type { InvoiceDeps, InvoiceRuntimeDeps } from "./invoices/context.js";
export { createFinanceConfigService } from "./finance-config/service.js";
export { createBillingAdjustments, createAdjustmentAssembly } from "./adjustments/index.js";
export type {
  BillingAdjustmentDeps,
  BillingApprovalRefs,
  AdjustmentActor,
} from "./adjustments/index.js";
export { createBillingAccounts } from "./read/account-ledger.js";
export {
  readInvoiceRefundGuard,
  markInvoiceRedPending,
  cancelInvoiceRed,
  rejectInvoiceAfterRefund,
} from "./invoices/refund.js";
export { createTermRefund } from "./subscription/index.js";
export { createPaymentExceptions } from "./payment/exceptions/index.js";
export type { PaymentExceptionDeps } from "./payment/exceptions/index.js";
export { readPaymentExceptionAlertFacts } from "./payment/exceptions/alerts.js";
export type { PaymentExceptionAlertFacts } from "./payment/exceptions/alerts.js";
export type { PlanRefundRule, PlanRefundPreview, RevokeTermResult } from "./subscription/index.js";

export {
  createRefunds,
  createRefundAssembly,
  createWechatRefundSource,
  recordRefundResult,
} from "./refund/index.js";
export { quotePlan } from "./catalog/index.js";
export type { Refunds, RefundDeps } from "./refund/index.js";

export { submitExceptionRefund } from "./refund/index.js";
export type { ExceptionRefundInput } from "./refund/index.js";

export { createShippingAssembly } from "./payment/shipping-assembly.js";

export { createStagingPayEntry } from "./staging-pay/entry.js";

export { createStagingPayAssembly, unboundStagingAutorefundJob } from "./staging-pay/assembly.js";
