import { createDocsRenderRuntime, createLicenseRenderingEngine } from "./docs-render-runtime.js";
import type { LicenseRenderingEngine } from "./docs-render-runtime.js";
import { assertLicenseFileVisible } from "../docs/index.js";
import { createBillingApprovalRefs } from "../support/index.js";
import type { BillingPurchaseDeps } from "../billing/index.js";
import {
  createWechatPaymentSource,
  createWechatChannel,
  bindPaymentChannel,
  createPayment,
  createFulfillment,
  createTransferReviewAssembly,
  createInvoiceAssembly,
  createRefunds,
  createRefundAssembly,
  createStagingPayAssembly,
  createReconciliationAssembly,
  createShippingAssembly,
  createWechatRefundSource,
} from "../billing/index.js";
import { createRuntimeMediaAssets, createMediaAssetsAssembly } from "./media-assets-runtime.js";
import { createServerErrorReporter, reportWorkerOutcome } from "./server-errors.js";
import type { ServerErrorReporter } from "./server-errors.js";
import { createDeliveryProductionAssembly } from "./delivery-production-runtime.js";
import { createApprovalSlaAssembly } from "./approval-sla-runtime.js";
import {
  createTenantEntitlementAssembly,
  createRuntimeTenantEntitlement,
} from "./tenant-entitlement-runtime.js";
import { createProfileLifecycleAssembly } from "./profile-lifecycle-runtime.js";
import { createInvitationAssembly } from "./invitation-runtime.js";
import { createModelBudgetRuntime } from "./model-budget-runtime.js";
import { createBillMissingObserver } from "./bill-missing.js";
import { createProbe, PROBE_QUERY_MS } from "./probe.js";
import { sqlProbeRules } from "./probe-rules.js";
import { operationalProbeRules } from "./operational-probe-rules.js";
import { financialProbeRules } from "./financial-probe-rules.js";
import { readPaymentExceptionAlertFacts } from "../billing/index.js";
import { queueProbeRules } from "./queue-probe-rules.js";
import { backupProbeRules } from "./backup-probe-rules.js";
import type { QueueId } from "@liyoxi/contract/registry";
import type { SqlRunner } from "./binding.js";
import { createInvitationExpiry } from "../tenant/index.js";
import {
  isQualificationDead,
  createProfileTenantLifecycle,
  createProfileConsistencyAssembly,
  createProfileConsistencyTransactions,
  createProfileQualificationConsistency,
  listFinalRejectedQualificationScopes,
} from "../profile/index.js";
import { createApproval } from "../approval/index.js";
import { createDeliverySlaAssembly } from "./delivery-sla-runtime.js";
import { createContentPricingAssembly } from "./content-pricing-runtime.js";
import {
  createContent,
  createContentLicense,
  createContentMaintenance,
  DramaUsagePort,
  readCurrentLicenseEnd,
} from "../content/index.js";
import { createDramaPricing } from "../billing/index.js";
import { staffBriefs } from "../staff/index.js";
import { requireRuntimeProductionAccess } from "./production-access-runtime.js";
import { readProductionMasterVersion } from "../content/index.js";
import { latestStaffWecomInviteKey } from "../audit/index.js";
import { createConfig, bindAgreementNoticeLink } from "../config/index.js";
import { createSmsHealth, smsTemplateReader, sendSystemAlert } from "../notify/index.js";
import { keyringFromEnv } from "../security/index.js";
import { createDocsAssembly, createRuntimeDocs } from "./docs-runtime.js";
import { createDocsLicenseAssembly, createRuntimeDocsLicense } from "./docs-license-runtime.js";
import { createRuntimeNotify, createNotifyAssembly } from "./notify-runtime.js";
import { readAgreementNoticeLink } from "../docs/index.js";
// 任务进程的服务装配（W0-23）：apps/worker 启动时调一次，拿到四个循环与两个队列消费者要调的用例函数。
// 依据：D7 第 2.3 节规则 7、8，第 8.3 节“应用侧的数据库会话设置与连接池”；计划 第 5.1 节。
// 应用层不引数据包（CLAUDE.md 第 6 节规则 5）：连接池在这里建，apps/worker 只把拿到的对象原样传回来。
import { createAnalyticsJobs } from "../analytics/index.js";
import { findWechatIdentityId, recentWechatOpenid } from "../identity/index.js";
import { createWechatReceiptHandler } from "../notify/index.js";
import type { NotifyQueueRef } from "../notify/index.js";
import { createPrismaClient, createSessionMutexConnectionFactory } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";

import { bindDelivery, reevaluateSweep, getTicketBriefByOrderItem } from "../delivery/index.js";
import { createSla } from "../sla/index.js";
import { bindContent } from "../content/index.js";
import {
  bindOrder,
  bindOrderStart,
  bindCancelRequests,
  createOrderReconciler,
} from "../order/index.js";
import type { OrderReconcileResult } from "../order/index.js";
import { assignDeliveryManager } from "../profile/index.js";
import { recommendedStaff, createStaffAssembly } from "../staff/index.js";
import { staffWorkSourcesOf } from "../kernel/index.js";
import { sendStaffWecomInvite } from "../notify/index.js";
import { createTenant } from "../tenant/index.js";
import { bindPublish } from "../publish/index.js";
import { createMedia } from "../media/index.js";
import { createMediaAssembly, mediaSweepOptions } from "./media-runtime.js";
import { createRuntimeMediaBatches } from "./media-batches-runtime.js";
import { createRuntimeMediaProduction } from "./media-production-runtime.js";
import { createAlertFactsAssembly } from "./alert-facts-runtime.js";
import { createCertAssembly } from "./cert-runtime.js";
import { createBackupAssembly } from "./backup-runtime.js";
import { createAlertDispatcher } from "./alert-delivery.js";
import type { ModelBudgetTransport, PromoteRef } from "../media/index.js";
import {
  advanceDueAccounts,
  createLedger,
  bindBillingTimers,
  createBillingDailyAssembly,
  createBillingDailyProjection,
} from "../billing/index.js";
import { createFlow } from "../flow/index.js";
import type { AdvanceSweepOptions, AdvanceSweepResult } from "../billing/index.js";
import { consumeDelivery, createEvents, dispatchDue, EXPAND_BATCH_SIZE } from "../events/index.js";
import type {
  ConsumeOutcome,
  DeliveryRef,
  DispatchOptions,
  DispatchResult,
  Events,
  TestEventDefinition,
} from "../events/index.js";
import {
  alertsOf,
  assembleProviders,
  createDocumentConverter,
  createTxRunner,
  createSessionMutex,
  createBizNoIssuer,
  systemClock,
} from "../kernel/index.js";
import type {
  AppEnv,
  Assembly,
  BidxKeysConfig,
  Clock,
  DataKeysConfig,
  Env,
  KernelViolation,
  QueueChannel,
  SessionMutex,
} from "../kernel/index.js";
import type { ProviderLogger, Providers, ProductionMediaTools } from "../providers/types.js";
import { notificationFailed } from "../providers/types.js";
import { createTimers, runTimer, scanDue } from "../timers/index.js";
import type {
  EnsureRecurringResult,
  RunTimerOutcome,
  ScanOptions,
  ScanResult,
  TimerCatalog,
  TimerRef,
  Timers,
} from "../timers/index.js";
import { bindOps } from "./binding.js";
import { createInvariantReportingAssembly } from "./invariants/index.js";
import {
  bindWebhooks,
  createWebhooks,
  createWechatMessageSource,
  createCiWebhookSource,
  createAsrWebhookSource,
} from "../security/index.js";
import type { WebhookSource, Webhooks } from "../security/index.js";
import { createStartupChecks, runStartupChecks } from "./startup.js";

/** worker 主池（D7 第 8.3 节）：10 条连接，语句 30 秒、等锁 3 秒、事务内空闲 60 秒 */
export function connectWorkerDatabase(connectionString: string): {
  prisma: PrismaClient;
  sessionMutex: SessionMutex;
  close(): Promise<void>;
} {
  const prisma = createPrismaClient({
    connectionString,
    max: 10,
    statementTimeoutMs: 30_000,
    lockTimeoutMs: 3_000,
    idleInTransactionSessionTimeoutMs: 60_000,
  });
  const sessionMutex = createSessionMutex({
    connect: createSessionMutexConnectionFactory({ connectionString }),
  });
  let closing: Promise<void> | undefined;
  return {
    prisma,
    sessionMutex,
    close: () =>
      (closing ??= (async () => {
        try {
          await sessionMutex.close();
        } finally {
          await prisma.$disconnect();
        }
      })()),
  };
}

export interface WorkerServicesOptions {
  readonly licenseRendering?: LicenseRenderingEngine;
  readonly serverErrorSource?: Readonly<{ release: string; artifactRoot: URL }>;
  readonly sessionMutex?: SessionMutex;
  readonly probe?: {
    readonly db: SqlRunner;
    readonly holder: () => string | undefined;
    readonly queues?: readonly QueueId[];
  };
  /** 明确配置域名；测试可注入不联网的TLS探针。 */
  readonly certificateProbe?: Parameters<typeof createCertAssembly>[1]["probe"];
  readonly backupProcessRunner?: Parameters<typeof createBackupAssembly>[1]["processRunner"];
  /** 本实例自有模型驱动的成对生命周期；close须缓存同一Promise，借用providers不消费此口。 */
  readonly modelDrivers?: {
    registerClose(close: () => Promise<void>): void;
    close(): Promise<void>;
  };
  /** 入口借给本实例的专用预算transport；连接关闭仍归入口。缺省保守关闭。 */
  readonly modelBudgetTransport?: ModelBudgetTransport;
  readonly documentWorkerUrl?: URL;
  readonly wechat?: {
    readonly config: NonNullable<Env["WECHAT"]>;
    readonly transport: NonNullable<Parameters<typeof assembleProviders>[0]["wechat"]>;
  };
  readonly webhookSources?: readonly WebhookSource[];
  readonly appEnv: AppEnv;
  /** 业务连接池：connectWorkerDatabase 给的；用例传测试库的客户端 */
  readonly prisma: PrismaClient;
  /** assembleServices({ entry: "worker" }) 的结果；用例传测试装配 */
  readonly assembly: Assembly;
  readonly channel: Pick<QueueChannel, "enqueue" | "downForMs"> &
    Partial<Pick<QueueChannel, "ping" | "observe">>;
  /** 业务时钟，缺省系统时钟 */
  readonly clock?: Clock;
  /** stg、prod 下内核违规往哪报 */
  readonly report?: (violation: KernelViolation) => void;
  /** 进程的日志口：Provider 的生效状态、放行的自检项往这里记。不给即不记（用例） */
  readonly logger?: ProviderLogger;
  /** loadEnv 的密钥与本地存储配置（把 env 整个传进来即可）：启动自检及 Provider 装配用。 */
  readonly keys?: {
    readonly LYX_PDF_FONT_DIR?: Env["LYX_PDF_FONT_DIR"];
    readonly ESIGN_SSM?: Env["ESIGN_SSM"];
    readonly PORTAL_PUBLIC_ORIGIN?: Env["PORTAL_PUBLIC_ORIGIN"];
    readonly WECHAT_PAY?: Env["WECHAT_PAY"];
    readonly STAGING_PAY?: Env["STAGING_PAY"];
    readonly MAIL_TENCENT?: Env["MAIL_TENCENT"];
    readonly OCR_TENCENT?: Env["OCR_TENCENT"];
    readonly DATA_KEYS?: DataKeysConfig;
    readonly BIDX_KEYS?: BidxKeysConfig;
    readonly MINIO?: Env["MINIO"];
    readonly COS?: Env["COS"];
    readonly SMS?: Env["SMS"];
    readonly CI?: Env["CI"];
    readonly MEDIA_PRODUCTION?: Env["MEDIA_PRODUCTION"];
    readonly ASR_TENCENT?: Env["ASR_TENCENT"];
    readonly ASR_CALLBACK?: Env["ASR_CALLBACK"];
    readonly LLM_DOMESTIC?: Env["LLM_DOMESTIC"];
    readonly CERT_DOMAINS?: Env["CERT_DOMAINS"];
    readonly BACKUP?: Env["BACKUP"];
    readonly ALERTS?: Env["ALERTS"];
    readonly SERVER_ERRORS?: Env["SERVER_ERRORS"];
  };
  /** 换掉十二个 Provider：只有用例会给（替身）。不给即 assembleProviders 按环境选实现 */
  readonly providers?: Providers;
  /** 仅local/test替换外部codec IO，沿既有守卫与本实例关闭链；默认生产装配不变。 */
  readonly mediaProductionTools?: ProductionMediaTools;
  /** 只给测试装配：样例事件与样例 kind 的名字来源 */
  readonly testEvents?: readonly TestEventDefinition[];
  readonly timerCatalog?: TimerCatalog;
}

export interface WorkerServices {
  renderLicenseRevision(ref: { revisionId: string }): Promise<void>;
  readonly pauseDocs?: () => Promise<void>;
  readonly resumeDocs?: () => void;
  readonly shutdownDocs?: () => Promise<void>;
  readonly serverErrors?: ServerErrorReporter;
  readonly closeServerErrors?: () => Promise<void>;
  readonly sessionMutex?: SessionMutex;
  readonly runProbes?: (beat?: () => void) => Promise<unknown>;
  readonly closeProbes?: () => Promise<void>;
  readonly closeCertificates?: () => Promise<void>;
  readonly closeBackups?: () => Promise<void>;
  readonly closeAlertDispatcher?: () => Promise<void>;
  readonly closeModelDrivers?: () => Promise<void>;
  readonly disableModelBudget?: () => void;
  readonly closeModelBudget?: () => Promise<void>;
  readonly closeDocs: () => Promise<void>;
  readonly documentConverter: ReturnType<typeof createDocumentConverter> | null;
  readonly closeSmsHealth?: () => Promise<void>;
  readonly closeAlertFacts?: () => Promise<void>;
  notifyDeliver(ref: NotifyQueueRef): Promise<void>;
  scanNotify(): Promise<number>;
  closeNotify(): Promise<void>;
  /** 只关闭本次装配创建的存储驱动；不关闭借用数据库、队列或 Redis。 */
  readonly closeStorageDrivers?: () => Promise<void>;
  readonly closeMediaDrivers?: () => Promise<void>;
  readonly closeMediaJobs?: () => void;
  readonly closeStaff?: () => Promise<void>;
  readonly closeApproval?: () => void;
  readonly closeProfile?: () => Promise<void>;
  readonly closeInvitations?: () => void;
  readonly shutdownMediaJobs?: () => Promise<void>;
  readonly pauseMediaJobs?: () => Promise<void>;
  readonly resumeMediaJobs?: () => void;
  readonly closeWebhooks?: () => void;
  readonly webhooks?: Webhooks;
  readonly closeAnalytics?: () => Promise<void>;
  reprocessWebhooks(beat?: () => void): Promise<number>;
  readonly closeOrder?: () => void | Promise<void>;
  readonly closeBillingTimers?: () => void;
  readonly closePublish?: () => void;
  readonly closeDelivery?: () => void;
  reevaluateDelivery(): Promise<{ inspected: number; moved: number }>;
  reconcileOrders(beat?: () => void): Promise<OrderReconcileResult>;
  promoteFile(ref: PromoteRef): Promise<void>;
  scanPromote(beat?: () => void): Promise<number>;
  readonly assembly: Assembly;
  readonly events: Events;
  readonly timers: Timers;
  /** 十二个外部能力。每个方法入口先过外呼前钩子：在事务里调，local、test 抛错，stg、prod 上报后照常调 */
  readonly providers: Providers;
  /**
   * 启动自检，与 api 同一份清单（ops/startup.ts）：连库、字段加密的密钥环、审计对象类型、聚合类型、
   * 状态机表与状态列。有一项不过即抛 StartupCheckError，问题一次列全
   */
  selfCheck(): Promise<void>;
  /** 出站中继的一轮：把未展开的事件展开到没有更多；返回展开的事件数 */
  relay(beat?: () => void): Promise<number>;
  /** 出站派发的一轮 */
  dispatch(options?: DispatchOptions): Promise<DispatchResult>;
  /** 出站投递队列的处理器 */
  consume(ref: DeliveryRef): Promise<ConsumeOutcome>;
  /** 定时器扫描的一轮 */
  scan(options?: ScanOptions): Promise<ScanResult>;
  /** 定时器执行队列的处理器 */
  runTimer(ref: TimerRef): Promise<RunTimerOutcome>;
  /** 周期任务补登记的一轮 */
  ensureRecurring(): Promise<EnsureRecurringResult>;
  /** 账务推进的一轮（循环 billing_advance，W1-10）：next_due_at 已到的主体逐个 advance，被占着的跳过 */
  advanceBilling(options?: AdvanceSweepOptions): Promise<AdvanceSweepResult>;
}

const silent: ProviderLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * 建 events、timers（两者在构造时对照契约校验订阅者、处理器、周期任务的登记，对不上即抛错）与十二个 Provider，并绑好依赖。
 * 这里不连 Redis、不查库、不外呼：selfCheck 才查库。
 */
export function buildWorkerServices(options: WorkerServicesOptions): WorkerServices {
  const cos = options.keys?.COS;
  const ci = options.keys?.CI;
  const asrCallback =
    options.providers === undefined && options.keys?.ASR_TENCENT
      ? options.keys.ASR_CALLBACK
      : undefined;
  if (ci && !ci.worker) throw new TypeError("CI worker入口缺少worker角色");
  if (cos && !cos.worker) throw new TypeError("COS worker入口缺少worker角色");
  const ownsModels =
    options.providers === undefined &&
    (options.keys?.ASR_TENCENT !== undefined || options.keys?.LLM_DOMESTIC !== undefined);
  const modelDrivers = options.providers === undefined ? options.modelDrivers : undefined;
  if (
    ownsModels &&
    (typeof modelDrivers?.registerClose !== "function" || typeof modelDrivers?.close !== "function")
  )
    throw new TypeError("模型配置须成对提供本实例关闭登记与关闭函数");
  const { prisma, channel } = options;
  const documentConverter = options.documentWorkerUrl
    ? createDocumentConverter({ workerUrl: options.documentWorkerUrl })
    : null;
  const clock = options.clock ?? systemClock;
  const mediaClosers: Array<() => Promise<void>> = [];
  let mediaClosing: Promise<void> | undefined;
  const closeMediaDrivers = () =>
    (mediaClosing ??= Promise.all(mediaClosers.map((close) => close())).then(() => undefined));
  const storageClosers: Array<() => Promise<void>> = [];
  let storageClosing: Promise<void> | undefined;
  const closeStorageDrivers = (): Promise<void> =>
    (storageClosing ??= Promise.all(storageClosers.map((close) => close())).then(() => undefined));
  const notificationClosers: Array<() => Promise<void>> = [];
  const logger = options.logger ?? silent;
  const profileCommits = createProfileConsistencyTransactions(
    createTxRunner({ prisma, appEnv: options.appEnv, report: options.report }),
    () =>
      logger.error({ evt: "profile.consistency_notification_failed" }, "资质一致性提交后通知失败"),
  );
  const tx = profileCommits.tx;
  const alertFactsScope = createAlertFactsAssembly(
    createInvariantReportingAssembly(options.assembly, { db: prisma, clock }),
    { tx, clock, logger },
  );
  const certificateScope = createCertAssembly(alertFactsScope.assembly, {
    tx,
    clock,
    domains: options.keys?.CERT_DOMAINS ?? [],
    ...(options.certificateProbe ? { probe: options.certificateProbe } : {}),
  });
  const backupScope = createBackupAssembly(certificateScope.assembly, {
    tx,
    clock,
    ...(options.keys?.BACKUP ? { config: options.keys.BACKUP } : {}),
    storage: () => providers.storage,
    ...(options.backupProcessRunner ? { processRunner: options.backupProcessRunner } : {}),
  });
  const analyticsScope = createAnalyticsJobs(backupScope.assembly, {
    tx,
    clock,
    appEnv: options.appEnv,
    storage: () => providers.storage,
  });
  const notifyScope = createNotifyAssembly(analyticsScope.assembly);
  const billingDailyScope = createBillingDailyAssembly(notifyScope.assembly);
  const mediaScope = createMediaAssembly(billingDailyScope.assembly);
  const mediaAssetsScope = createMediaAssetsAssembly(mediaScope.assembly);
  const staffScope = createStaffAssembly(mediaAssetsScope.assembly);
  const transferReviewScope = createTransferReviewAssembly(staffScope.assembly);
  const approvalSlaScope = createApprovalSlaAssembly(transferReviewScope.assembly);
  const profileLifecycleScope = createProfileLifecycleAssembly(approvalSlaScope.assembly);
  const profileConsistencyScope = createProfileConsistencyAssembly(profileLifecycleScope.assembly);
  const contentPricingScope = createContentPricingAssembly(profileConsistencyScope.assembly);
  const deliveryProductionScope = createDeliveryProductionAssembly(contentPricingScope.assembly);
  const deliverySlaScope = createDeliverySlaAssembly(deliveryProductionScope.assembly);
  const docsScope = createDocsAssembly(deliverySlaScope.assembly);
  const docsLicenseScope = createDocsLicenseAssembly(docsScope.assembly);
  const invitationScope = createInvitationAssembly(docsLicenseScope.assembly);
  const entitlementScope = createTenantEntitlementAssembly(invitationScope.assembly);
  const invoiceScope = createInvoiceAssembly(entitlementScope.assembly);
  const refundScope = createRefundAssembly(invoiceScope.assembly);
  const stagingPayScope = createStagingPayAssembly(refundScope.assembly);
  const reconciliationScope = createReconciliationAssembly(stagingPayScope.assembly);
  const shippingScope = createShippingAssembly(reconciliationScope.assembly);
  const assembly = shippingScope.assembly;
  const events = createEvents({ assembly, clock, tx, testEvents: options.testEvents });
  deliverySlaScope.attach({ events, clock });
  const timers = createTimers({ assembly, catalog: options.timerCatalog });
  const probe = options.probe
    ? createProbe({
        ...options.probe,
        tx,
        clock,
        logger,
        rules: [
          ...sqlProbeRules(options.probe.db),
          ...financialProbeRules(options.probe.db, (at) =>
            tx.run((t) => readPaymentExceptionAlertFacts(t, at), {
              timeoutMs: PROBE_QUERY_MS,
              maxWaitMs: PROBE_QUERY_MS,
            }),
          ),
          ...queueProbeRules(options.probe.queues ?? [], channel.observe?.bind(channel)),
          ...backupProbeRules(options.probe.db),
          ...operationalProbeRules(
            options.probe.db,
            timers.registry.recurringJobs,
            channel.ping ? () => channel.ping!() : undefined,
          ),
        ],
      })
    : null;
  const flow = createFlow({ assembly, clock, events });
  invoiceScope.attach({ clock, events, flow, timers, sla: createSla({ clock, assembly }) });
  invitationScope.attach(createInvitationExpiry({ clock, flow, timers }));
  const wechatSources = options.wechat
    ? [
        createWechatMessageSource({
          cryptoConfig: {
            appid: options.wechat.config.appid,
            token: options.wechat.config.messageToken,
            encodingAESKey: options.wechat.config.messageEncodingAESKey,
          },
          logger,
          findWechatIdentityId,
          handleImage: (t, input, ctx) => media.applyWechatImageResult(t, input, ctx),
          handleSubscription: createWechatReceiptHandler({ clock, logger }),
        }),
      ]
    : [];
  const webhooks = createWebhooks({
    tx,
    clock,
    events,
    sources: options.webhookSources ?? [
      ...wechatSources,
      createWechatRefundSource({
        base: createWechatPaymentSource({
          provider: () => providers.wechatPay,
          identity: () => options.keys?.WECHAT_PAY,
          channel: () => paymentChannel,
          alerts: alertsOf(assembly),
        }),
        provider: () => providers.wechatPay,
        identity: () => options.keys?.WECHAT_PAY,
        deps: refundScope.current,
      }),
      createCiWebhookSource({
        key: ci?.callback.key,
        wake: (tx, input) => media.wakeCiJob(tx, input),
      }),
      ...(asrCallback !== undefined
        ? [
            createAsrWebhookSource({
              key: asrCallback?.key,
              configured: () => asrCallbackEnabled,
              wake: (tx, input) => media.wakeAsrJob(tx, input),
            }),
          ]
        : []),
    ],
    alerts: alertsOf(assembly),
  });
  const closeWebhooks = bindWebhooks(webhooks);
  const closeBillingTimers = bindBillingTimers({
    clock,
    flow,
    timers,
  });
  const providers =
    options.providers ??
    assembleProviders({
      appEnv: options.appEnv,
      logger,
      ...(options.keys?.WECHAT_PAY ? { wechatPay: { now: () => clock.now() } } : {}),
      settings: {
        ...(options.keys?.MAIL_TENCENT ? { mail: options.keys.MAIL_TENCENT } : {}),
        ...(options.keys?.OCR_TENCENT ? { ocr: options.keys.OCR_TENCENT } : {}),
        ...(options.keys?.WECHAT_PAY ? { wechatPay: options.keys.WECHAT_PAY } : {}),
        ...(options.keys?.ALERTS?.robotKey
          ? { wecomRobot: { key: options.keys.ALERTS.robotKey } }
          : {}),
        ...(options.keys?.ASR_TENCENT !== undefined ? { asr: options.keys.ASR_TENCENT } : {}),
        ...(options.keys?.LLM_DOMESTIC !== undefined ? { llm: options.keys.LLM_DOMESTIC } : {}),
        ...(options.keys?.SMS
          ? {
              sms: {
                driver: "tencent" as const,
                tencent: {
                  config: options.keys.SMS,
                  getTemplate: smsTemplateReader(prisma),
                  now: () => clock.now(),
                },
              },
            }
          : {}),
        ...(ci?.worker
          ? {
              media: {
                ci: {
                  region: ci.worker.region,
                  buckets: ci.worker.buckets,
                  worker: { secretId: ci.worker.secretId, secretKey: ci.worker.secretKey },
                  callback: ci.callback,
                },
              },
            }
          : {}),
        ...(options.keys?.MINIO || options.keys?.BACKUP
          ? {
              storage: {
                minio: {
                  ...options.keys?.MINIO,
                  ...(options.keys?.BACKUP ? { backup: options.keys.BACKUP.target } : {}),
                },
              },
            }
          : {}),
        ...(cos
          ? {
              storage: {
                driver: "cos" as const,
                cos: {
                  region: cos.region,
                  buckets: cos.buckets,
                  worker: cos.worker,
                  ...(options.keys?.BACKUP ? { backup: options.keys.BACKUP.target } : {}),
                },
              },
            }
          : {}),
        ...(options.wechat
          ? { wechat: { appid: options.wechat.config.appid, secret: options.wechat.config.secret } }
          : {}),
      },
      ...(options.keys?.ALERTS?.robotKey
        ? {
            wecomRobot: {
              registerClose: (close: () => Promise<void>) => notificationClosers.push(close),
            },
          }
        : {}),
      ...(options.keys?.OCR_TENCENT
        ? {
            ocr: {
              registerClose: (close: () => Promise<void>) => mediaClosers.push(close),
            },
          }
        : {}),
      ...(options.keys?.MAIL_TENCENT
        ? {
            mail: {
              now: () => clock.now(),
              registerClose: (close: () => Promise<void>) => notificationClosers.push(close),
            },
          }
        : {}),
      ...(ci?.worker
        ? {
            media: {
              now: () => clock.now(),
              registerClose: (close: () => Promise<void>) => mediaClosers.push(close),
            },
          }
        : {}),
      ...(cos
        ? {
            storage: {
              now: () => clock.now(),
              registerClose: (close: () => Promise<void>) => storageClosers.push(close),
            },
          }
        : {}),
      ...(options.wechat
        ? {
            wechat: options.wechat.transport,
          }
        : {}),
      ...(options.keys?.ASR_TENCENT !== undefined
        ? {
            asr: {
              ...(asrCallback ? { callback: asrCallback } : {}),
              now: () => clock.now(),
              registerClose: (close: () => Promise<void>) => modelDrivers!.registerClose(close),
            },
          }
        : {}),
      ...(options.keys?.LLM_DOMESTIC !== undefined
        ? {
            llm: {
              registerClose: (close: () => Promise<void>) => modelDrivers!.registerClose(close),
            },
          }
        : {}),
    });
  const asrCallbackEnabled =
    asrCallback !== undefined && providers.asr.configured && providers.asr.status === "tencent";
  const modelBudget = createModelBudgetRuntime({
    clock,
    prefix: `lyx:${options.appEnv}:`,
    transport: options.modelBudgetTransport,
    alerts: alertsOf(assembly),
    logger,
  });
  const mediaProduction = createRuntimeMediaProduction(
    options.keys?.MEDIA_PRODUCTION,
    providers,
    options.mediaProductionTools
      ? { appEnv: options.appEnv, tools: options.mediaProductionTools }
      : undefined,
  );
  mediaClosers.push(() => mediaProduction.close());
  const smsHealth = createSmsHealth({
    db: prisma,
    tx,
    clock,
    config: createConfig({ db: prisma, clock, redis: null }),
    sms: providers.sms,
    alerts: alertsOf(assembly),
    env: options.appEnv,
    keyring: () =>
      options.keys?.DATA_KEYS && options.keys.BIDX_KEYS ? keyringFromEnv(options.keys) : null,
  });
  notifyScope.attachSmsHealth(smsHealth);
  const media = createMedia({
    licenseAccess: assertLicenseFileVisible,
    ...(options.sessionMutex
      ? {
          ocr: {
            provider: providers.ocr,
            sessionMutex: options.sessionMutex,
            keyring: () => keyringFromEnv(options.keys ?? {}),
          },
        }
      : {}),
    ...(options.sessionMutex
      ? {
          retention: {
            sessionMutex: options.sessionMutex,
            alerts: alertsOf(assembly),
            staffBriefs,
            sweep: mediaSweepOptions(
              createConfig({ db: prisma, clock, redis: null }).params,
              (tx, id) => notify.remindAssetDemand(tx, id),
            ),
          },
        }
      : {}),
    assets: createRuntimeMediaAssets({
      clock,
      assembly,
      timers,
      providers,
      asrCallback: asrCallbackEnabled,
      modelBudget: modelBudget.admission,
    }),
    batches: createRuntimeMediaBatches({ clock, events, media: () => media }),
    productionAccess: {
      require: requireRuntimeProductionAccess,
      master: readProductionMasterVersion,
      staff: async (tx, id) => (await staffBriefs(tx, [id]))[0] ?? null,
    },
    ...(mediaProduction.production ? { production: mediaProduction.production } : {}),
    tx,
    clock,
    assembly,
    events,
    storage: providers.storage,
    channel,
    moderation: providers.media,
    wechatImage: {
      appid: options.wechat?.config.appid,
      provider: providers.wechat,
      fallback: providers.media,
      recentWechatOpenid,
    },
  });
  mediaScope.attach(media.jobs, media.retention);
  mediaAssetsScope.attach(media);
  const docsConfig = createConfig({ db: prisma, clock, redis: null });
  const docsServices = createRuntimeDocs({
    tx,
    clock,
    assembly,
    media,
    storage: providers.storage,
    converter: documentConverter,
    events,
    config: docsConfig,
    bumpAgreement: () => docsConfig.cache.bump("agreement"),
  });
  const licenseConvergence = createRuntimeDocsLicense({
    clock,
    flow,
    events,
    portalOrigin: options.keys?.PORTAL_PUBLIC_ORIGIN,
    keyring: () => keyringFromEnv(options.keys ?? {}),
  });
  const docsRender = createDocsRenderRuntime({
    tx,
    clock,
    alerts: alertsOf(assembly),
    convergence: licenseConvergence,
    media,
    channel,
    logger,
    allowStamp: ["local", "test"].includes(options.appEnv),
    engine: createLicenseRenderingEngine({
      appEnv: options.appEnv,
      clock,
      fontDir: options.keys?.LYX_PDF_FONT_DIR,
      ssm: options.keys?.ESIGN_SSM,
      override: options.licenseRendering,
    }),
  });
  docsScope.attach({
    ...docsServices.jobs,
    licenseQueue: docsRender.queue,
    enqueueLicenseRevision: docsRender.enqueue,
  });
  docsLicenseScope.attach(licenseConvergence);
  const closeMediaJobs = () => {
    mediaAssetsScope.close();
    mediaScope.close();
  };
  const startupChecks = createStartupChecks({
    db: prisma,
    appEnv: options.appEnv,
    keys: options.keys ?? {},
    warn: (message) => logger.warn({ evt: "startup.check_skipped" }, message),
  });
  const alerts = alertsOf(assembly);
  // ops 的周期任务与违规上报端口要连接、时钟与装配结果（W0-24）
  bindOps({ db: prisma, tx, clock, assembly });
  const closeAnalytics = () => analyticsScope.close();
  bindContent(assembly);
  const contentLicense = createContentLicense({ clock, flow, timers });
  const content = createContent({ clock, flow, media, assembly, events, license: contentLicense });
  const dramaPricing = createDramaPricing({ clock, content, staffBriefs, events, timers });
  contentPricingScope.attach({
    license: contentLicense,
    pricing: dramaPricing,
    maintenance: createContentMaintenance({ clock, usage: assembly.port(DramaUsagePort), media }),
  });
  const closePublish = bindPublish(assembly);
  const deliveryCore = {
    get approval() {
      return approval;
    },
    tx,
    clock,
    assembly,
    flow,
    events,
    media,
    sla: createSla({ clock, assembly }),
  };
  approvalSlaScope.attach({ clock, events, flow, timers, sla: deliveryCore.sla });
  const unbindDelivery = bindDelivery(deliveryCore);
  deliveryProductionScope.attach({ clock, flow, media });
  const closeDelivery = () => {
    deliveryProductionScope.close();
    deliverySlaScope.close();
    unbindDelivery();
  };
  const delivery = {
    tx,
    beforeConsume: async (...args: Parameters<typeof shippingScope.beforeConsume>) => {
      await shippingScope.beforeConsume(...args);
      await docsRender.beforeConsume(...args);
    },
    subscribers: events.subscribers,
    channel,
    alerts,
    onFailure: (outcome: "retry" | "dead") =>
      reportWorkerOutcome(serverErrors, "delivery", outcome),
  };
  // 账本（W1-10）：每分钟扫描用它推进到点的主体
  const ledger = createLedger({ clock, events });
  billingDailyScope.attach({ ledger, ...createBillingDailyProjection({ ledger }) });
  const approval = createApproval({
    assembly,
    clock,
    flow,
    events,
    timers,
    sla: deliveryCore.sla,
    bizNo: createBizNoIssuer({ clock, appEnv: options.appEnv }),
  });
  const orderCancelDeps = {
    tx,
    clock,
    flow,
    events,
    approval,
    ledger,
    timers,
    sla: deliveryCore.sla,
    assembly,
  };
  const closeCancelRequests = bindCancelRequests(orderCancelDeps);
  const orderReconciler = createOrderReconciler({
    tx,
    clock,
    assembly,
    cancel: orderCancelDeps,
    ensureLetters: docsLicenseScope.ensureLetters,
    qualificationScopes: listFinalRejectedQualificationScopes,
    currentLicenseEnd: readCurrentLicenseEnd,
    ticketByItem: getTicketBriefByOrderItem,
  });
  const closeDerive = bindOrder({
    assembly,
    clock,
    flow,
    media,
    cancel: { tx, clock, flow, events, approval, ledger, timers, sla: deliveryCore.sla, assembly },
  });
  const tenant = createTenant({ tx, clock, flow, assembly });
  const workerPurchaseDeps: BillingPurchaseDeps = {
    assembly,
    media,
    ledger,
    docs: docsServices.docs,
    approval,
    sla: deliveryCore.sla,
    tx,
    clock,
    tenant,
    config: createConfig({ db: prisma, clock, redis: null }),
    keyring: () => keyringFromEnv(options.keys ?? {}),
    flow,
    timers,
    events,
    bizNo: createBizNoIssuer({ clock, appEnv: options.appEnv }),
    payment: createPayment({
      clock,
      flow,
      events,
      timers,
      bizNo: createBizNoIssuer({ clock, appEnv: options.appEnv }),
      fulfillment: createFulfillment({ clock, events }),
    }),
    ...(options.keys?.WECHAT_PAY
      ? {
          wechatPay: {
            provider: providers.wechatPay,
            appid: options.keys.WECHAT_PAY.appid,
            mchid: options.keys.WECHAT_PAY.mchid,
            currentOpenid: async () => {
              throw new TypeError("worker不接受付款会话");
            },
          },
        }
      : {}),
  };
  transferReviewScope.attach(workerPurchaseDeps);
  shippingScope.attach({
    tx,
    clock,
    sessionMutex: options.sessionMutex,
    provider: providers.wechat,
    appid: options.wechat?.config.appid,
    paymentAppid: options.keys?.WECHAT_PAY?.appid,
    mchid: options.keys?.WECHAT_PAY?.mchid,
  });
  const refundDeps = {
    ...workerPurchaseDeps,
    stagingPay: {
      APP_ENV: options.appEnv,
      ...(options.keys?.STAGING_PAY ? { STAGING_PAY: options.keys.STAGING_PAY } : {}),
    },
    isQualificationDead,
    approvalRefs: createBillingApprovalRefs({ clock }),
  };
  refundScope.attach(refundDeps);
  stagingPayScope.attach(refundDeps);
  if (options.sessionMutex)
    reconciliationScope.attach({
      ...refundDeps,
      sessionMutex: options.sessionMutex,
      systemFiles: media,
      orderPrefix: options.appEnv === "stg" ? "TFK" : "FK",
      observeBillMissing: createBillMissingObserver({ tx, clock }),
    });
  const refunds = createRefunds(refundDeps);
  const paymentChannel = createWechatChannel(workerPurchaseDeps);
  const closePaymentChannel = bindPaymentChannel(paymentChannel);
  profileConsistencyScope.attach(
    createProfileQualificationConsistency({
      assembly,
      clock,
      tenant,
      approval,
      events,
      commits: profileCommits,
    }),
  );
  profileLifecycleScope.attach(
    createProfileTenantLifecycle({ clock, tenant, approval, events, media }),
  );
  const closeStart = bindOrderStart({
    ...deliveryCore,
    timers,
    ledger,
    recommendStaff: recommendedStaff,
    assignManager: (t, ctx, input) =>
      assignDeliveryManager(t, { clock, assembly, tenant }, ctx, input),
  });
  // 扫描里出错过的主体（进程内的记忆）：下一轮排到正常的主体后面，不占着名额饿死别人
  const laggards = new Map<string, number>();
  const timing = {
    beforeRun: async (ref: Parameters<typeof paymentChannel.prepareExpire>[0]) => {
      await paymentChannel.prepareExpire(ref);
      await refunds.saga.preparePoll(ref);
    },
    tx,
    assembly,
    registry: timers.registry,
    clock,
    alerts,
    channel,
    onFailure: (outcome: "retry" | "failed") => reportWorkerOutcome(serverErrors, "timer", outcome),
  };
  const notify = createRuntimeNotify({
    events,
    tx,
    clock,
    assembly,
    appEnv: options.appEnv,
    providers,
    logger,
    keys: options.keys,
    appid: options.wechat?.config.appid,
    params: createConfig({ db: prisma, clock, redis: null }).params,
  });
  notifyScope.attach(notify);
  entitlementScope.attach(createRuntimeTenantEntitlement({ clock, assembly, notify }));
  staffScope.attach({
    tx,
    clock,
    flow,
    config: createConfig({ db: prisma, clock, redis: null }),
    keyring: () => keyringFromEnv(options.keys ?? {}),
    workSources: staffWorkSourcesOf(assembly),
    media,
    events,
    sla: deliveryCore.sla,
    timers,
    sendActivation: (input) =>
      notify.sendDirect({
        purpose: "staff_activation",
        templateKey: "verify_code",
        phone: input.phone,
        params: { code: input.code },
        directKey: `staff-activation:${input.activationId}`,
      }),
    sendWecomInvite: (input) =>
      tx.run(async (t) =>
        sendStaffWecomInvite(t, {
          staffId: input.staffId,
          invitationKey:
            (await latestStaffWecomInviteKey(t, input.staffId)) ?? input.createdAt.toISOString(),
          now: clock.now(),
        }),
      ),
  });
  const unbindNoticeLink = bindAgreementNoticeLink(readAgreementNoticeLink);
  const alertDispatcher = options.probe
    ? createAlertDispatcher({
        tx,
        clock,
        logger,
        holder: options.probe.holder,
        ...(options.keys?.ALERTS ? { config: options.keys.ALERTS } : {}),
        robot: (input) =>
          providers.wecom.capabilities?.robot === true
            ? providers.wecom.sendRobotMessage(input)
            : Promise.resolve(
                notificationFailed("unconfigured", "告警机器人尚未配置", {
                  acceptance: "not_accepted",
                  code: "unconfigured",
                }),
              ),
        sms: (input) => notify.sendOpsAlert(input),
        bell: (t, input) => sendSystemAlert(t, input, assembly),
      })
    : null;
  let alertClosing: Promise<void> | undefined;
  const closeAlertDispatcher = () =>
    (alertClosing ??= (async () => {
      try {
        await alertDispatcher?.close();
      } finally {
        await Promise.all(notificationClosers.map((close) => close()));
      }
    })());

  const serverErrors = options.serverErrorSource
    ? createServerErrorReporter({
        component: "worker",
        release: options.serverErrorSource.release,
        artifactRoot: options.serverErrorSource.artifactRoot,
        dsn: options.keys?.SERVER_ERRORS?.worker?.dsn,
        clock,
        logger,
      })
    : undefined;
  return {
    ...(serverErrors ? { serverErrors, closeServerErrors: () => serverErrors!.close() } : {}),
    ...(options.sessionMutex ? { sessionMutex: options.sessionMutex } : {}),
    ...(ownsModels ? { closeModelDrivers: () => modelDrivers!.close() } : {}),
    disableModelBudget: () => modelBudget.disable(),
    closeModelBudget: () => modelBudget.close(),
    renderLicenseRevision: docsRender.process,
    pauseDocs: docsRender.pause,
    resumeDocs: docsRender.resume,
    shutdownDocs: docsRender.pause,
    closeDocs: async () => {
      const results = await Promise.allSettled([docsRender.close(), docsScope.close()]);
      await docsLicenseScope.close();
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
    runProbes: async (beat) => {
      if (!probe) throw new Error("探针读侧未配置");
      const result = await probe.run(beat);
      // 通道派发有独立预算，不占用探针原20秒采样预算。
      await alertDispatcher?.run();
      return result;
    },
    closeProbes: () => probe?.close() ?? Promise.resolve(),
    closeCertificates: () => certificateScope.close(),
    closeBackups: () => backupScope.close(),
    closeAlertDispatcher,
    documentConverter,
    closeSmsHealth: () => smsHealth.close(),
    closeAlertFacts: () => alertFactsScope.close(),
    notifyDeliver: (ref) => notify.deliver(ref),
    scanNotify: () =>
      notify.scan(async (ref) => {
        if ("fanoutId" in ref)
          await channel.enqueue("notify", `fan-${ref.fanoutId}-${ref.pageKey}`, {
            fanoutId: ref.fanoutId,
          });
        else
          await channel.enqueue("notify", `dlv-${ref.deliveryId}-${ref.attemptNo}`, {
            deliveryId: ref.deliveryId,
          });
      }),
    closeNotify: async () => {
      await notifyScope.close();
      unbindNoticeLink();
    },
    closeStorageDrivers,
    closeMediaDrivers,
    closeMediaJobs,
    closeStaff: async () => {
      contentPricingScope.close();
      await staffScope.close();
    },
    closeApproval: () => {
      refundScope.close();
      stagingPayScope.close();
      reconciliationScope.close();
      shippingScope.close();
      invoiceScope.close();
      transferReviewScope.close();
      approvalSlaScope.close();
    },
    closeProfile: async () => {
      profileLifecycleScope.close();
      await profileConsistencyScope.close();
    },
    closeInvitations: () => {
      entitlementScope.close();
      invitationScope.close();
    },
    shutdownMediaJobs: () => media.jobs.shutdown(),
    pauseMediaJobs: () => media.jobs.pause(),
    resumeMediaJobs: () => media.jobs.resume(),
    closeWebhooks,
    closeAnalytics,
    reprocessWebhooks: (beat) => webhooks.scan(beat),
    closeOrder: async () => {
      await orderReconciler.close();
      closeStart();
      closeCancelRequests();
      closeDerive();
    },
    closeBillingTimers: () => {
      billingDailyScope.close();
      closeBillingTimers();
      closePaymentChannel();
    },
    closePublish,
    closeDelivery,
    reevaluateDelivery: () => reevaluateSweep(deliveryCore),
    reconcileOrders: (beat) => orderReconciler.run(beat),
    promoteFile: (ref) => media.promote(ref),
    async scanPromote(beat) {
      try {
        return await media.scanPromote(beat);
      } finally {
        await modelBudget.maintain();
      }
    },
    assembly,
    events,
    timers,
    webhooks,
    providers,
    selfCheck: async () => {
      await runStartupChecks(startupChecks);
      await notify.validateConfiguration();
    },
    async relay(beat) {
      let total = 0;
      for (;;) {
        const { events: expanded } = await events.expand();
        total += expanded;
        beat?.();
        if (expanded < EXPAND_BATCH_SIZE) return total;
      }
    },
    dispatch: (dispatchOptions) => dispatchDue(delivery, dispatchOptions),
    consume: (ref) => consumeDelivery(delivery, ref),
    scan: (scanOptions) => scanDue(timing, scanOptions),
    runTimer: (ref) => runTimer(timing, ref),
    ensureRecurring: () => tx.run((handle) => timers.ensureRecurring(handle, clock.now())),
    advanceBilling: (sweepOptions) =>
      advanceDueAccounts({ db: prisma, tx, clock, ledger, alerts, laggards }, sweepOptions),
  };
}
