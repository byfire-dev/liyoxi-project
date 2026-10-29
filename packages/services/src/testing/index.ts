// @liyoxi/services/testing：测试支撑设施的出口（D7 第 10.1 节）。只给测试用，不进生产装配。
// 各包只往这里加自己的导出行：W0-19 的 Provider 替身在 ./providers；测试库支架、可拨时钟、故障注入属 W0-05b。

export * from "./providers/index.js";

// W0-05b：测试库支架（守卫、按 worker 建库、重置）转导出自 @liyoxi/db/testing；
// 另有 Redis 的前缀隔离、可拨时钟、四种故障注入。用法见本目录的 README.md。
export * from "@liyoxi/db/testing";
export * from "./clock.js";
export * from "./fault/index.js";
export * from "./redis.js";

// W0-07b：测试装配（真实模块的登记之外追加样例登记）
export * from "./assembly.js";
// W0-20：三段式的样例用例（探针表上的“预下单尝试”），只在测试里挂
export * from "./three-phase-samples.js";

// W0-15：出站事件的样例事件、样例订阅者，与测试装配之上的 events
export * from "./events.js";
// W0-17：五个端口的样例实现（记下收到的调用）
export * from "./ports.js";

// W0-17：工作日历的样例数据
export * from "./calendar.js";

// W0-17：定时器的样例 kind、带样例的名字来源与样例登记
export * from "./timers.js";
// W0-16：状态迁移的样例守卫、活动流默认描述、固定日历的工作分钟实现，与测试装配之上的 flow
export * from "./flow.js";
// W0-23：任务进程的样例订阅者、定时器处理器、周期任务（带业务副作用，用例据此断言恰好一次）
export * from "./worker.js";
// 只在类型上带上 globalSetup 对 Vitest 的声明补充（inject("lyxTestMaxWorkers") 的类型）：
// 应用层的包只引本入口，不带这一行它们的类型检查过不了。运行时没有这条导入
import type {} from "./global-setup.js";

// W0-25：测试数据支撑——工厂、带种子的干净库、表快照比较器、假 Provider 支架。用法见 ./data/README.md
export * from "./data/index.js";
// W1-01a：后台登录的支架——假密钥、测试库上的凭据用例、接口测试的登录态 signInAsStaff
export * from "./staff.js";

// W0-30：M0 的样例链路（写用例 → 状态迁移 → 审计与出站事件 → 订阅者 → 定时器 → 全量不变量），用例与 pnpm demo:m0 共用
export * from "./m0-chain.js";
// W1-06：审批的样例类型（探针表上的假领域行）、样例领域用例，与照库里的员工行建员工上下文的办法
export * from "./approval.js";

// W1-10：账本用例的夹具——一步建好账本、造周期与发放计划、加购入账、账本现状的可比快照
export * from "./billing.js";
export { prepareClosedBillingDays } from "./billing-daily.js";
// W1-11a：履约用例的夹具——账本夹具加履约、已支付未履约的套餐付款单
export * from "./billing-fulfill.js";
export * from "./billing-payment.js";

// W1-15a：完整订剧前置，供真实 API / clerk 测试复用。
export * from "./order.fixture.js";
export { createW501Publish, prepareW501AdCancel } from "./w501.fixture.js";

// W1-21：无 Vitest 的 M1 接口重放/演示；工厂内才读固定媒体并创建本轮隔离资源。
export { createM1Support } from "./m1-support.js";
export { M1OwnerNetworkSchema } from "./m1-owner-network.js";
export { createM1WorkerResources, M1WorkerAttachmentSchema } from "./m1-worker.js";
export type { M1LoopWorkerSnapshot } from "./m1-worker.js";
export { prepareM1WorkerExercise } from "./m1-worker.fixture.js";
export { waitM1Worker, assertM1WorkerKnown, m1WorkerObserver } from "./m1-observe.js";
export type { M1WorkerBacklog } from "./m1-observe.js";
export {
  assertM1SharedScope,
  createM1HttpStorage,
  createM1RealClock,
  waitM1Due,
} from "./m1-shared.js";
export { createM2Support } from "./m2-chain.js";
export type { M2Support, M2FactScope } from "./m2-chain.js";
export { createP95Fixture } from "./p95-fixture.js";
export type { P95Dataset } from "./p95-fixture.js";
export { createM3Support } from "./m3-support.js";
export { createM4Support } from "./m4-support.js";
export type { M4Support } from "./m4-support.js";
export { verifyM4DemoReplay } from "./m4-demo.js";
export type { M4DemoReplayContext, M4DemoReplayResult } from "./m4-demo.js";
export type { M3Support, M3SupportOptions, M3MediaScope, M3DrainOptions } from "./m3-support.js";
export type {
  M1Support,
  M1SupportOptions,
  M1OrderScope,
  M1Scope,
  M1MediaScope,
  M1StateIds,
  M1SharedScope,
  M1Attachment,
  M1HttpObjectIO,
} from "./m1-types.js";

export { configTestStaffBriefs, createConfigProfileFixture } from "./config-admin.js";
export { createTestWorkerServices, runTestInvariants } from "./ops-runtime.js";

// W2-12：两个应用的真实转换产物共享虚构文件；仅测试入口可用。
export {
  docx as fictionalDocumentDocx,
  pdf as fictionalDocumentPdf,
  docxParts as fictionalDocumentParts,
  zip as fictionalDocumentZip,
  boundaryDocx as fictionalDocumentBoundaryDocx,
} from "./document-fixtures.js";
export {
  createNotifyMessageFixture,
  changeNotifyMessageAccessFixture,
  createNotifySessionFixture,
  createNotifyQuotaFixture,
  updateNotifySlotFixture,
} from "./notify-messages.js";
export { createFlowOpsCliSupport } from "./flow-ops-cli.js";

export { installSitePurchasePolicy } from "./site.js";
export { createAnalyticsCliSupport } from "./analytics-cli.js";
export { notificationFixture } from "./notify-dispatch.js";
export {
  createOutputBatchLiveFixture,
  prepareOutputBatchLiveMasters,
  findOutputBatchLiveJobIds,
  consumeOutputBatchLiveChecked,
  OutputBatchLiveInputSchema,
} from "./admin-live/w302.fixture.js";
export type { OutputBatchLiveInput } from "./admin-live/w302.fixture.js";
export { createBatchMediaForTest } from "./media-batches.js";
export { createOutputBatchToolsForTest, outputBatchInputFromProbe } from "./output-batch-tools.js";

export { fullStaffWorld } from "./staff-full.js";
export type { FullStaffWorld } from "./staff-full.js";

export {
  createDeliveryProductionTools,
  finishDeliveryProductionForTest,
  prepareDeliveryMasterForTest,
} from "./delivery-production-tools.js";
export type { DeliveryProductionTools } from "./delivery-production-tools.js";
export { createCodecDemoMasterPreparer } from "./demo-masters.js";
export { createDocsAdminFixture } from "./docs-admin.js";
export { findAgreementLiveUploadJobIds } from "./admin-live/agreements-m2-upload.js";
export { createMerchantAssetLiveUploadPump } from "./admin-live/merchant-assets-upload.js";
export {
  createInvoiceLiveUploadPump,
  parseInvoiceLiveUploadScope,
} from "./admin-live/invoice-upload.js";
export { seedBillingDeletionFacts } from "./billing-deletion.js";

// W3-12: exact owned content scope for the existing private live server.
export {
  ContentAdminLiveScopeSchema,
  parseOutputBatchLiveManifest,
  assertContentAdminLiveScope,
  assertContentAdminLiveTargets,
  findContentAdminLiveJobIds,
} from "./admin-live/w312.fixture.js";
export type { ContentAdminLiveScope } from "./admin-live/w312.fixture.js";
export { finishW120LiveFixture } from "./admin-live/w120.fixture.js";

export { createMediaProductionHarness } from "./media-production-harness.js";
export type { MediaProductionHarness } from "./media-production-harness.js";
export { createMediaAssetsHarness } from "./media-assets.js";
export {
  createMediaToolClient as createMediaToolClientForTest,
  createMediaWorkspace as createMediaWorkspaceForTest,
} from "../providers/index.js";
export {
  createIdentity as createIdentityForTest,
  assertCurrentSession as assertCurrentSessionForTest,
  currentSessionOpenid as currentSessionOpenidForTest,
} from "../identity/index.js";

// W4-10：worker CLI只经公开测试入口消费真实退款机制，不跨模块导入私有fixture。
export {
  createRefundHarness as createRefundHarnessForTest,
  refundIdem as refundIdempotencyForTest,
} from "./billing-refund.js";
export type { RefundHarness as RefundHarnessForTest } from "./billing-refund.js";

export { createReconciliationHarness } from "./bill-reconciliation.js";
export type { ReconciliationHarness } from "./bill-reconciliation.js";
export { sourceBill } from "./bill-source.js";
export type { SourceBillRow } from "./bill-source.js";
export { findBillingLiveUploadJobIds } from "./admin-live/billing-upload.js";

// 仅公开运行时生成的假X509身份，供FILE配置边界测试复用，不导入真实证书。
export { merchantCertificateForTest } from "./wechatpay-certificate.js";

// W5-02: shared real qualification prerequisites without crossing private profile fixtures.
export {
  createQualificationFixtureUscc,
  installQualificationFixtureDicts,
  createQualificationFixtureFile,
  completeQualificationFixture,
  submitQualificationFixture,
} from "./qualification.fixture.js";
export type { QualificationFixture } from "./qualification.fixture.js";
