import { createWechatPaymentSource, bindPaymentChannel } from "./billing/index.js";
import {
  createRuntimeMediaAssets,
  createMediaAssetsAssembly,
  createModelBudgetRuntime,
} from "./ops/index.js";
import { readTargetActivity } from "./audit/index.js";
import {
  createProfileConsistencyAssembly,
  createProfileConsistencyTransactions,
  createProfileQualificationConsistency,
} from "./profile/index.js";
import {
  createDeliveryProductionAssembly,
  createDeliverySlaAssembly,
  createContentPricingAssembly,
  createContentAdmin,
  createInvitationAssembly,
} from "./ops/index.js";
import type { ContentAdmin } from "./ops/index.js";
import {
  createContentCopyright,
  createContentLicense,
  createContentMaintenance,
  DramaPricePort,
  DramaUsagePort,
} from "./content/index.js";
import { createDramaPricing } from "./billing/index.js";
import { createPlanAdmin, createParameterChanges } from "./billing/index.js";
import { latestStaffWecomInviteKey } from "./audit/index.js";
import { createSmsInit, createSmsHealth, smsTemplateReader } from "./notify/index.js";
import { keyringFromEnv } from "./security/index.js";
import {
  createAnalyticsJobs,
  createAnalyticsReceiver,
  countBannerClicks,
} from "./analytics/index.js";
import type { AnalyticsReceiver, AnalyticsJobs } from "./analytics/index.js";
import type { NotifyDispatcherService } from "./notify/index.js";
import { bindAgreementNoticeLink } from "./config/index.js";
import { createSubscribeResults, createWechatReceiptHandler } from "./notify/index.js";
import {
  currentSessionOpenid,
  findWechatIdentityId,
  recentWechatOpenid,
} from "./identity/index.js";
import type { SubscribeResults } from "./notify/index.js";
import { createDocsAssembly, createRuntimeDocs } from "./ops/index.js";
import type { Docs } from "./docs/index.js";
import { createClientErrorForwarder, createServerErrorReporter } from "./ops/index.js";
import type { ClientErrorForwarder, ServerErrorReporter } from "./ops/index.js";
import { createFlowOps, createAlertActions } from "./ops/index.js";
import type { FlowOps, AlertActions } from "./ops/index.js";
import { createAuditRead } from "./audit/index.js";
import { bindDelivery } from "./delivery/index.js";
import {
  createOrderService,
  bindOrder,
  bindOrderStart,
  readUnassignedStoreOrderIds,
  syncUnassignedStoreOrders,
} from "./order/index.js";
import { assignDeliveryManager } from "./profile/index.js";
import type { OrderService } from "./order/index.js";
import { bindPublish } from "./publish/index.js";
// 进程运行时（W0-22）：api 与 worker 启动时各建一次。环境 → 日志 → 数据库与 Redis 连接 → 事务入口、业务单号、
// 配置读侧、健康检查 → 服务装配。应用层只经 @liyoxi/services 的入口拿到它，不引 @liyoxi/db（硬性规则 5）。
// 依据：D7 第 2.3 节规则 7、第 8.3 节“应用侧的数据库会话设置与连接池”、第 9.1 节；h01 第 3.12 节；
// docs/plan/tasks/README.md 第 5 节移交表第 1、2 行。
//
// 为什么是包级文件、不放 kernel/context.ts：kernel 的入口被全部模块引用，放进去每个用例都要加载数据库客户端；
// 它还要引 config、ops 的入口，会成环。包级文件不属于任何一层，只引各模块的 index.ts（与组合根 assembly.ts 同）。
//
// 数据库客户端与 Redis 连接不在返回值里：应用层用不到，也不该拿到。以后各域的服务（buildXxx(deps)）在这里装配，
// 经返回值给出用例函数。
// KF-1 接齐的三样：十二个 Provider 经 kernel 的 assembleProviders 装配（驱动的入口只许 kernel 引，D7 第 2.2 节 D8；
// 外呼前钩子在那里接上，事务内外呼有人拦）；events、timers 在这里各建一次（构造时对照契约校验订阅者、定时器处理器、
// 周期任务的登记，对不上进程起不来）；启动自检用 ops 的清单（两个进程共用）。
// W1-01a 接进来的两样：flow（状态迁移，装配之后、events 之上建一次）与 staffAuth（后台登录与会话的用例）。
// staffAuth 第一次取时才加载密钥并装配：本地与用例里不配密钥文件进程也起得来，只是后台登录用不了；
// stg、prod 下三份密钥缺了由启动自检拦（security.crypto 两份；api 进程另有 security.auth_keys）。
import { createPrismaClient, createSessionMutexConnectionFactory } from "@liyoxi/db";
import { createSessionMutex } from "./kernel/index.js";
import type { SessionMutex } from "./kernel/index.js";
import { Redis } from "ioredis";

import { assembleServices } from "./assembly.js";
import { createApproval, bindApprovalSla } from "./approval/index.js";
import type { Approval } from "./approval/index.js";
import {
  bindBillingTimers,
  createBillingPurchase,
  createTransferReviewAssembly,
  createInvoiceAssembly,
  createInvoices,
  createFinanceConfigService,
  createLedger,
  createPayment,
  createFulfillment,
  getNotifyPurchaseMode,
  createBillingDailyAssembly,
  createBillingDailyProjection,
} from "./billing/index.js";
import type { BillingPurchase, BillingPurchaseDeps } from "./billing/index.js";
import { createNotifyMessages } from "./notify/index.js";
import type { NotifyMessages } from "./notify/index.js";
import { staffBriefs, createStaffAssembly } from "./staff/index.js";
import { staffWorkSourcesOf } from "./kernel/index.js";
import { sendStaffWecomInvite } from "./notify/index.js";
import { readAgreementNoticeLink } from "./docs/index.js";
import { createTenant, createInvitationExpiry } from "./tenant/index.js";
import { createSla, createCalendarAdmin, bindCalendarCoverage } from "./sla/index.js";
import type { CalendarAdmin } from "./sla/index.js";
import type { Keyring } from "./security/index.js";
import {
  createConfig,
  createConfigAdmin,
  createSiteAdmin,
  normalizeSiteNoticeLink,
  createNotices,
} from "./config/index.js";
import type { Config, ConfigAdmin, SiteAdmin } from "./config/index.js";
import { createEvents } from "./events/index.js";
import type { Events } from "./events/index.js";
import { createFlow } from "./flow/index.js";
import type { Flow } from "./flow/index.js";
import {
  alertsOf,
  piiFieldsOf,
  assembleProviders,
  createDocumentConverter,
  createBizNoIssuer,
  createTxRunner,
  createQueueChannel,
  detach,
  systemClock,
} from "./kernel/index.js";
import type {
  Assembly,
  AssemblyEntry,
  BizNoIssuer,
  Clock,
  Env,
  KernelViolation,
  TxRunner,
} from "./kernel/index.js";
import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import {
  bindOps,
  createInvariantReportingAssembly,
  createHealth,
  createStartupChecks,
  createRuntimeNotify,
  createNotifyAssembly,
  createTenantEntitlementAssembly,
  createRuntimeTenantEntitlement,
  createAlertFactsAssembly,
} from "./ops/index.js";
import type { Health, StartupCheck } from "./ops/index.js";
import type { Providers, ProductionMediaTools } from "./providers/types.js";
import { createContent, bindContent, readTemplatePriceCandidates } from "./content/index.js";
import type { Content } from "./content/index.js";
import { createMedia } from "./media/index.js";
import {
  createMediaAssembly,
  mediaSweepOptions,
  createRuntimeMediaBatches,
  createRuntimeMediaProduction,
} from "./ops/index.js";
import type { Media, ModelBudgetTransport } from "./media/index.js";
import { createRateLimiter } from "./rate-limit.js";
import type { RateLimiter } from "./rate-limit.js";
import {
  loadAuthKeys,
  loadKeyring,
  createPiiReveal,
  bindWebhooks,
  createWebhooks,
  createWechatMessageSource,
  createCiWebhookSource,
  createAsrWebhookSource,
} from "./security/index.js";
import type { Webhooks, WebhookSource } from "./security/index.js";
import {
  createStaffAuth,
  recommendedStaff,
  createRoleManagement,
  createStaffSelfSecurity,
  createStaffFollowUps,
} from "./staff/index.js";
import type { StaffAuth, createStaffManagement } from "./staff/index.js";
import { createTimers } from "./timers/index.js";
import type { Timers } from "./timers/index.js";

// 启动自检的运行器与类型在 ops/startup.ts（worker 的装配也用）；这里照旧给出，包入口的导出不变
export { runStartupChecks, StartupCheckError } from "./ops/index.js";
export type { StartupCheck } from "./ops/index.js";

/** 一个连接池的参数：连接数上限与三个会话超时（毫秒） */
export interface DbPoolSettings {
  readonly max: number;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly idleInTransactionSessionTimeoutMs?: number;
}

/**
 * 两个进程的主池，照 D7 第 8.3 节的表。读侧池（api 3 个连接、worker 3 个连接）与 worker 的租约连接
 * 等第一个用到它们的包再建。
 */
export const DB_POOLS: Readonly<Record<AssemblyEntry, DbPoolSettings>> = {
  api: {
    max: 10,
    statementTimeoutMs: 8_000,
    lockTimeoutMs: 3_000,
    idleInTransactionSessionTimeoutMs: 15_000,
  },
  worker: {
    max: 10,
    statementTimeoutMs: 30_000,
    lockTimeoutMs: 3_000,
    idleInTransactionSessionTimeoutMs: 60_000,
  },
};

export interface RuntimeOptions {
  /** 仅进程入口提供自有dist目录；测试/借用装配不自动启用服务端出口。 */
  readonly serverErrorRoot?: URL;
  /** API自有ASR/LLM/OCR的成对生命周期；close须缓存同一Promise，整套providers借用不消费。 */
  readonly modelDrivers?: {
    registerClose(close: () => Promise<void>): void;
    close(): Promise<void>;
  };
  /** API入口借入的独立预算连接；本运行时只排空准入，连接关闭仍归入口。 */
  readonly modelBudgetTransport?: ModelBudgetTransport;
  readonly documentWorkerUrl?: URL;
  /** Only local/test external-tool substitution; production facts and handlers stay real. */
  readonly mediaProductionTools?: ProductionMediaTools;
  readonly webhookSources?: readonly WebhookSource[];
  /** 仅测试/演示装配传假密钥；生产仍通过受控配置延迟加载。 */
  readonly billingKeyring?: Keyring;
  /** 哪个进程 */
  readonly entry: AssemblyEntry;
  /** loadEnv 的结果 */
  readonly env: Env;
  /** 镜像标签：构建时写进产物；本地与用例里是 dev */
  readonly version: string;
  /** 不给即系统时钟；用例里传可拨时钟 */
  readonly clock?: Clock;
  /** 不给即按 env.LOG_LEVEL 建一个写标准输出的；用例里传收集用的 */
  readonly logger?: Logger;
  /** Redis 键的前缀，缺省 lyx:<环境>:（D7 第 2.5 节）；用例里传测试支架给的前缀 */
  readonly redisKeyPrefix?: string;
  /** /health 的缓存时长；用例里给 0 */
  readonly healthCacheMs?: number;
  /** 限流等 Redis 一条命令的时限，缺省 200 毫秒；用例里放宽，免得机器忙时把慢当成断 */
  readonly rateLimitCommandTimeoutMs?: number;
  /**
   * 换掉十二个 Provider：只有用例会给（替身，createFakeProviders 或 W0-25 的支架，它们自带“事务内不外呼”的钩子）。
   * 不给即 assembleProviders 按环境选实现。
   */
  readonly providers?: Providers;
}

export interface Runtime {
  readonly sessionMutex: SessionMutex;
  readonly docs: Docs;
  readonly docsAdmin: ReturnType<typeof createRuntimeDocs>["admin"];
  readonly documentConverter: ReturnType<typeof createDocumentConverter> | null;
  readonly smsInit: ReturnType<typeof createSmsInit>;
  readonly analytics: AnalyticsReceiver;
  readonly analyticsPartitions: Pick<AnalyticsJobs, "repartition">;
  readonly subscribeResults: SubscribeResults;
  readonly clientErrors: ClientErrorForwarder;
  readonly serverErrors?: ServerErrorReporter;
  readonly webhooks: Webhooks;
  readonly order: OrderService;
  readonly billing: BillingPurchase & {
    invoices: ReturnType<typeof createInvoices>;
    financeConfig: ReturnType<typeof createFinanceConfigService>;
  };
  readonly billingPlansAdmin: ReturnType<typeof createPlanAdmin>;
  readonly billingParameters: ReturnType<typeof createParameterChanges>;
  readonly notifyMessages: NotifyMessages;
  readonly notify: NotifyDispatcherService;
  readonly content: Content;
  readonly contentAdmin: ContentAdmin;
  readonly media: Media;
  /** 审批执行器与只读队列：api、worker 各自装配（移交表 64） */
  readonly approval: Approval;
  readonly entry: AssemblyEntry;
  readonly env: Env;
  readonly version: string;
  readonly logger: Logger;
  readonly clock: Clock;
  /** 开事务的唯一入口 */
  readonly tx: TxRunner;
  readonly bizNo: BizNoIssuer;
  readonly config: Config;
  readonly configAdmin: ConfigAdmin;
  readonly siteAdmin: SiteAdmin;
  readonly calendarAdmin: CalendarAdmin;
  readonly health: Health;
  /** 限流计数：Redis 上的固定窗口，Redis 不可用时进程内兜底、限额减半（约定 C68） */
  readonly rateLimiter: RateLimiter;
  /** 各模块的登记汇成的装配结果 */
  readonly assembly: Assembly;
  /** 十二个外部能力。每个方法入口先过外呼前钩子：在事务里调，local、test 抛错，stg、prod 上报后照常调 */
  readonly providers: Providers;
  /** 出站事件：emit 与展开。构造时已对照契约校验订阅者登记 */
  readonly events: Events;
  /** 定时器的登记、改期、取消。构造时已对照契约校验处理器与周期任务的登记 */
  readonly timers: Timers;
  /** 内核断言在 stg、prod 下的上报出口（local、test 下它们直接抛错）；防漏用断言也用它 */
  report(violation: KernelViolation): void;
  /** 启动自检的清单：由 runStartupChecks 逐项跑 */
  readonly startupChecks: readonly StartupCheck[];
  /** 断开数据库与 Redis。进程退出前调一次 */
  close(): Promise<void>;
  /** 状态迁移（W1-01a 接进来）：改状态机表的状态只经 flow.transition */
  readonly flow: Flow;
  /**
   * 后台登录与会话的用例（W1-01a）：登录两步、激活四步、再验证、每请求的会话校验、退出、命令行引导。
   * 第一次取时才加载密钥并装配；三份密钥文件（DATA_KEYS_FILE、BIDX_KEYS_FILE、AUTH_KEYS_FILE）没配全即抛 SecurityError
   */
  readonly staffAuth: StaffAuth;
  readonly staffManagement: ReturnType<typeof createStaffManagement>;
  readonly followUps: ReturnType<typeof createStaffFollowUps>;
  readonly staffRoles: ReturnType<typeof createRoleManagement>;
  readonly staffSelfSecurity: ReturnType<typeof createStaffSelfSecurity>;
  readonly auditRead: ReturnType<typeof createAuditRead>;
  readonly flowOps: FlowOps;
  readonly alertActions: AlertActions;
  readonly piiReveal: ReturnType<typeof createPiiReveal>;
}

/**
 * 建进程运行时。不等连接：数据库用到时才连；Redis 当场在后台开始连，不等它连上，连不上不影响启动。
 * 会抛的几种：参数缺定义（ParamDefsError）、模块登记有重名或缺实现（AssemblyError）、订阅者或定时器的登记与契约
 * 对不上（SubscriberRegistryError、TimerRegistryError）、Provider 的选项与环境对不上（ProviderConfigError）。
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  const { entry, env, version } = options;
  const ownsModels =
    options.providers === undefined &&
    ((entry === "api" && (!!env.ASR_TENCENT || !!env.LLM_DOMESTIC)) || !!env.OCR_TENCENT);
  const ownsAsr = entry === "api" && options.providers === undefined && !!env.ASR_TENCENT;
  const ownsOcr = options.providers === undefined && !!env.OCR_TENCENT;
  const ownsMail = entry === "worker" && options.providers === undefined && !!env.MAIL_TENCENT;
  const asrCallback = ownsAsr ? env.ASR_CALLBACK : undefined;
  const modelDrivers = ownsModels ? options.modelDrivers : undefined;
  if (
    ownsModels &&
    (typeof modelDrivers?.registerClose !== "function" || typeof modelDrivers?.close !== "function")
  )
    throw new TypeError(
      ownsAsr
        ? "API ASR配置须成对提供本实例关闭登记与关闭函数"
        : ownsOcr
          ? "OCR配置须成对提供本实例关闭登记与关闭函数"
          : "API LLM配置须成对提供本实例关闭登记与关闭函数",
    );
  if (entry === "worker" && env.CI && !env.CI.worker)
    throw new TypeError("CI worker入口缺少worker角色");
  if (env.COS && (entry === "worker" ? !env.COS.worker : !env.COS.signer || !env.COS.stsIssuer))
    throw new TypeError("当前进程 COS 角色配置不完整");
  const clock = options.clock ?? systemClock;
  const logger =
    options.logger ?? createLogger({ svc: entry, env: env.APP_ENV, level: env.LOG_LEVEL, version });

  const prisma = createPrismaClient({ connectionString: env.DATABASE_URL, ...DB_POOLS[entry] });
  const sessionMutex = createSessionMutex({
    connect: createSessionMutexConnectionFactory({ connectionString: env.DATABASE_URL }),
  });

  const keyPrefix = options.redisKeyPrefix ?? `lyx:${env.APP_ENV}:`;
  // 一条命令只等一次重连：Redis 不可用时调用方很快拿到错误，各自降级（01 第 7.3 节）
  const redis = new Redis(env.REDIS_URL, { keyPrefix, maxRetriesPerRequest: 1 });
  let redisDown = false;
  redis.on("error", (error: Error) => {
    // ioredis 每次重连失败都发一次 error：只在由通转断时记一条
    if (!redisDown) logger.warn({ evt: "redis.down", err: error }, "Redis 连接出错，正在重连");
    redisDown = true;
  });
  redis.on("ready", () => {
    if (redisDown) logger.info({ evt: "redis.up" }, "Redis 连接已恢复");
    redisDown = false;
  });

  const report = (violation: KernelViolation): void => {
    logger.error({ evt: "kernel.violation", err: violation }, violation.message);
  };
  const profileCommits = createProfileConsistencyTransactions(
    createTxRunner({ prisma, appEnv: env.APP_ENV, report }),
    () =>
      logger.error({ evt: "profile.consistency_notification_failed" }, "资质一致性提交后通知失败"),
  );
  const tx = profileCommits.tx;
  const config = createConfig({
    db: prisma,
    clock,
    redis,
    report: (problem) => {
      logger.error(
        { evt: "config.problem", kind: problem.kind, subject: problem.subject },
        problem.detail,
      );
    },
  });
  const health = createHealth({
    db: prisma,
    redis,
    clock,
    version,
    ...(options.healthCacheMs === undefined ? {} : { cacheMs: options.healthCacheMs }),
  });
  const notifyMessages = createNotifyMessages({
    tx,
    clock,
    config,
    purchaseMode: getNotifyPurchaseMode,
  });
  const clientErrors = createClientErrorForwarder({
    clock,
    logger,
    projects: env.CLIENT_ERROR_PROJECTS?.projects ?? [],
  });
  const rateLimiter = createRateLimiter({
    store: redis,
    clock,
    logger,
    ...(options.rateLimitCommandTimeoutMs === undefined
      ? {}
      : { commandTimeoutMs: options.rateLimitCommandTimeoutMs }),
  });
  const alertFactsScope = createAlertFactsAssembly(
    createInvariantReportingAssembly(assembleServices({ entry, appEnv: env.APP_ENV }), {
      db: prisma,
      clock,
    }),
    {
      tx,
      clock,
      logger,
    },
  );
  const analyticsScope = createAnalyticsJobs(alertFactsScope.assembly, {
    tx,
    clock,
    appEnv: env.APP_ENV,
    storage: () => providers.storage,
  });
  const notifyScope = createNotifyAssembly(analyticsScope.assembly);
  const billingDailyScope = createBillingDailyAssembly(notifyScope.assembly);
  const mediaScope = createMediaAssembly(billingDailyScope.assembly);
  const mediaAssetsScope = createMediaAssetsAssembly(mediaScope.assembly);
  const staffScope = createStaffAssembly(mediaAssetsScope.assembly);
  const profileConsistencyScope = createProfileConsistencyAssembly(staffScope.assembly);
  const contentPricingScope = createContentPricingAssembly(profileConsistencyScope.assembly);
  const deliveryProductionScope = createDeliveryProductionAssembly(contentPricingScope.assembly);
  const deliverySlaScope = createDeliverySlaAssembly(deliveryProductionScope.assembly);
  const docsScope = createDocsAssembly(deliverySlaScope.assembly);
  const invitationScope = createInvitationAssembly(docsScope.assembly);
  const entitlementScope = createTenantEntitlementAssembly(invitationScope.assembly);
  const transferReviewScope = createTransferReviewAssembly(entitlementScope.assembly);
  const invoiceScope = createInvoiceAssembly(transferReviewScope.assembly);
  const assembly = invoiceScope.assembly;
  const documentConverter = options.documentWorkerUrl
    ? createDocumentConverter({ workerUrl: options.documentWorkerUrl })
    : null;
  // 违规上报端口（invariants.report）的实现在 ops，要连接、时钟与装配结果（W0-24）
  const unbindOps = bindOps({ db: prisma, tx, clock, assembly });
  const wechatClosers: Array<() => Promise<void>> = [];
  const providers =
    options.providers ??
    assembleProviders({
      appEnv: env.APP_ENV,
      logger,
      settings: {
        ...(ownsAsr ? { asr: env.ASR_TENCENT } : {}),
        ...(ownsOcr ? { ocr: env.OCR_TENCENT } : {}),
        ...(ownsMail ? { mail: env.MAIL_TENCENT } : {}),
        ...(ownsModels && entry === "api" && env.LLM_DOMESTIC ? { llm: env.LLM_DOMESTIC } : {}),
        ...(env.SMS
          ? {
              sms: {
                driver: "tencent" as const,
                tencent: {
                  config: env.SMS,
                  getTemplate: smsTemplateReader(prisma),
                  now: () => clock.now(),
                },
              },
            }
          : {}),
        ...(entry === "worker" && env.CI?.worker
          ? {
              media: {
                ci: {
                  region: env.CI.worker.region,
                  buckets: env.CI.worker.buckets,
                  worker: { secretId: env.CI.worker.secretId, secretKey: env.CI.worker.secretKey },
                  callback: env.CI.callback,
                },
              },
            }
          : {}),
        ...(env.MINIO ? { storage: { minio: env.MINIO } } : {}),
        ...(env.COS
          ? {
              storage: {
                driver: "cos" as const,
                cos: {
                  region: env.COS.region,
                  buckets: env.COS.buckets,
                  ...(entry === "worker"
                    ? { worker: env.COS.worker }
                    : { signer: env.COS.signer, stsIssuer: env.COS.stsIssuer }),
                },
              },
            }
          : {}),
        ...(env.WECHAT_PAY ? { wechatPay: env.WECHAT_PAY } : {}),
        ...(env.WECHAT ? { wechat: { appid: env.WECHAT.appid, secret: env.WECHAT.secret } } : {}),
      },
      ...(ownsAsr
        ? {
            asr: {
              ...(asrCallback ? { callback: asrCallback } : {}),
              now: () => clock.now(),
              registerClose: (close: () => Promise<void>) => modelDrivers!.registerClose(close),
            },
          }
        : {}),
      ...(ownsModels && entry === "api" && env.LLM_DOMESTIC
        ? {
            llm: {
              registerClose: (close: () => Promise<void>) => modelDrivers!.registerClose(close),
            },
          }
        : {}),
      ...(ownsOcr
        ? {
            ocr: {
              registerClose: (close: () => Promise<void>) => modelDrivers!.registerClose(close),
            },
          }
        : {}),
      ...(ownsMail
        ? {
            mail: {
              now: () => clock.now(),
              registerClose: (close: () => Promise<void>) => wechatClosers.push(close),
            },
          }
        : {}),
      ...(entry === "worker" && env.CI?.worker
        ? {
            media: {
              now: () => clock.now(),
              registerClose: (close: () => Promise<void>) => wechatClosers.push(close),
            },
          }
        : {}),
      ...(env.COS
        ? {
            storage: {
              now: () => clock.now(),
              registerClose: (close: () => Promise<void>) => {
                wechatClosers.push(close);
              },
            },
          }
        : {}),
      ...(env.WECHAT_PAY ? { wechatPay: { now: () => clock.now() } } : {}),
      ...(env.WECHAT
        ? {
            wechat: {
              redis,
              prefix: keyPrefix,
              now: () => clock.now(),
              registerClose: (close: () => Promise<void>) => {
                wechatClosers.push(close);
              },
            },
          }
        : {}),
    });
  const asrCallbackEnabled =
    asrCallback !== undefined && providers.asr.configured && providers.asr.status === "tencent";
  if (entry === "worker")
    notifyScope.attachSmsHealth(
      createSmsHealth({
        db: prisma,
        tx,
        clock,
        config,
        sms: providers.sms,
        alerts: alertsOf(assembly),
        env: env.APP_ENV,
        keyring: () => (env.DATA_KEYS && env.BIDX_KEYS ? keyringFromEnv(env) : null),
      }),
    );
  const events = createEvents({ assembly, clock, tx });
  deliverySlaScope.attach({ events, clock });
  const wechatSources = env.WECHAT
    ? [
        createWechatMessageSource({
          cryptoConfig: {
            appid: env.WECHAT.appid,
            token: env.WECHAT.messageToken,
            encodingAESKey: env.WECHAT.messageEncodingAESKey,
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
      createWechatPaymentSource({
        provider: () => providers.wechatPay,
        identity: () => env.WECHAT_PAY,
        channel: () => billing.wechatChannel,
        alerts: alertsOf(assembly),
      }),
      createCiWebhookSource({
        key: env.CI?.callback.key,
        wake: (tx, input) => media.wakeCiJob(tx, input),
      }),
      ...(asrCallbackEnabled
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
  const unbindWebhooks = bindWebhooks(webhooks);
  const timers = createTimers({ assembly });
  const flow = createFlow({ assembly, clock, events });
  invitationScope.attach(createInvitationExpiry({ clock, flow, timers }));
  const reportingTenant = createTenant({ tx, clock, flow, assembly });
  const analytics = createAnalyticsReceiver({
    tx,
    clock,
    config,
    tenant: reportingTenant,
    alerts: alertsOf(assembly),
  });
  const subscribeResults = createSubscribeResults({
    tx,
    clock,
    params: config.params,
    alerts: alertsOf(assembly),
    logger,
  });
  const mediaChannel = createQueueChannel({ redisUrl: env.REDIS_URL, prefix: `${keyPrefix}bull` });
  const mediaProduction = createRuntimeMediaProduction(
    env.MEDIA_PRODUCTION,
    providers,
    options.mediaProductionTools
      ? { appEnv: env.APP_ENV, tools: options.mediaProductionTools }
      : undefined,
  );
  // API借用入口专用transport；默认额度与冷账本仍关闭，原TaskId回查不重复扣槽。
  const modelBudget =
    entry === "api"
      ? createModelBudgetRuntime({
          clock,
          prefix: `lyx:${env.APP_ENV}:`,
          transport: options.modelBudgetTransport,
          alerts: alertsOf(assembly),
          logger,
        })
      : undefined;
  const media = createMedia({
    ocr: {
      provider: providers.ocr,
      sessionMutex,
      keyring: () => (billingKeys ??= loadKeyring(env)),
    },
    retention: {
      sessionMutex,
      alerts: alertsOf(assembly),
      staffBriefs,
      sweep: mediaSweepOptions(config.params, (tx, id) => notify.remindAssetDemand(tx, id)),
    },
    assets: createRuntimeMediaAssets({
      clock,
      assembly,
      timers,
      providers,
      asrCallback: asrCallbackEnabled,
      ...(modelBudget ? { modelBudget: modelBudget.admission } : {}),
    }),
    batches: createRuntimeMediaBatches({ clock, events, media: () => media }),
    ...(mediaProduction.production ? { production: mediaProduction.production } : {}),
    tx,
    clock,
    assembly,
    events,
    storage: providers.storage,
    channel: mediaChannel,
    videoMaxMb: () => config.params.get("upload.weapp_video_max_mb"),
    moderation: providers.media,
    wechatImage: {
      appid: env.WECHAT?.appid,
      provider: providers.wechat,
      fallback: providers.media,
      recentWechatOpenid,
    },
  });
  mediaScope.attach(media.jobs, media.retention);
  mediaAssetsScope.attach(media);
  deliveryProductionScope.attach({ clock, flow, media });
  const docsServices = createRuntimeDocs({
    tx,
    clock,
    assembly,
    media,
    storage: providers.storage,
    converter: documentConverter,
    events,
    config,
    bumpAgreement: () => config.cache.bump("agreement"),
  });
  docsScope.attach(docsServices.jobs);
  const unbindContent = bindContent(assembly);
  const unbindPublish = bindPublish(assembly);
  const unbindDelivery = bindDelivery({
    media,
    tx,
    clock,
    assembly,
    flow,
    events,
    sla: createSla({ clock, assembly }),
  });
  const contentLicense = createContentLicense({ clock, flow, timers });
  const content = createContent({ clock, flow, media, assembly, events, license: contentLicense });
  const dramaPricing = createDramaPricing({ clock, content, staffBriefs, events, timers });
  contentPricingScope.attach({
    license: contentLicense,
    pricing: dramaPricing,
    maintenance: createContentMaintenance({ clock, usage: assembly.port(DramaUsagePort), media }),
  });
  const contentCopyright = createContentCopyright({
    clock,
    media,
    events,
    prices: assembly.port(DramaPricePort),
    license: contentLicense,
  });
  const contentAdmin = createContentAdmin({
    clock,
    tx,
    content,
    prices: assembly.port(DramaPricePort),
    staffBriefs,
    activity: readTargetActivity,
    pricing: (t, staff, id, at) => dramaPricing.detailPricing(t, staff, id, at),
    copyright: contentCopyright,
    pricingService: dramaPricing,
    media,
  });
  const bizNo = createBizNoIssuer({ clock, appEnv: env.APP_ENV });
  const sla = createSla({ clock, assembly });
  const approval = createApproval({ assembly, clock, flow, events, bizNo, sla, timers });
  profileConsistencyScope.attach(
    createProfileQualificationConsistency({
      assembly,
      clock,
      tenant: reportingTenant,
      approval,
      events,
      commits: profileCommits,
    }),
  );
  const unbindApprovalSla = bindApprovalSla({
    clock,
    flow,
    events,
    sla,
    timers,
    kinds: approval.kinds,
  });
  const notify = createRuntimeNotify({
    events,
    tx,
    clock,
    assembly,
    appEnv: env.APP_ENV,
    params: config.params,
    providers,
    logger,
    keys: env,
    keyring: options.billingKeyring,
    appid: env.WECHAT?.appid,
  });
  notifyScope.attach(notify);
  entitlementScope.attach(createRuntimeTenantEntitlement({ clock, assembly, notify }));
  const staffManagement = staffScope.attach({
    tx,
    clock,
    flow,
    config,
    keyring: () => keyringFromEnv(env),
    workSources: staffWorkSourcesOf(assembly),
    storeManagerOrders: {
      readUnassignedIds: readUnassignedStoreOrderIds,
      syncUnassigned: syncUnassignedStoreOrders,
    },
    media,
    events,
    sla,
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
  const configAdmin = createConfigAdmin({ tx, clock, assembly, config, staffBriefs });
  const siteAdmin = createSiteAdmin({
    tx,
    clock,
    assembly,
    config,
    staffBriefs,
    clicks: countBannerClicks,
    noticeLink: (t, notice) => normalizeSiteNoticeLink(t, notice, readAgreementNoticeLink),
    files: {
      link: async (t, fileId, bannerId) => {
        await media.link(t, {
          fileId,
          refType: "home_banner",
          refId: bannerId,
          role: "image",
          entityId: null,
          storeId: null,
        });
      },
      release: async (t, fileId, bannerId, keepUntil) => {
        await media.release(t, {
          fileId,
          refType: "home_banner",
          refId: bannerId,
          role: "image",
          keepUntil,
          entityId: null,
          storeId: null,
        });
      },
      sign: (fileId) => media.signRead({ fileId }),
    },
  });
  const calendarAdmin = createCalendarAdmin({ tx, clock, events });
  const unbindCalendarCoverage = bindCalendarCoverage({
    clock,
    alerts: alertsOf(assembly),
    detach,
  });
  const unbindBilling = bindBillingTimers({ clock, flow, timers });
  const ledger = createLedger({ clock, events });
  billingDailyScope.attach({ ledger, ...createBillingDailyProjection({ ledger }) });
  const unbindOrder = bindOrder({
    assembly,
    clock,
    flow,
    cancel: { tx, clock, flow, events, approval, ledger, timers, sla },
  });
  const tenant = createTenant({ tx, clock, flow, assembly });
  const unbindOrderStart = bindOrderStart({
    tx,
    clock,
    assembly,
    flow,
    events,
    timers,
    ledger,
    media,
    sla: createSla({ clock, assembly }),
    recommendStaff: recommendedStaff,
    assignManager: (t, ctx, input) =>
      assignDeliveryManager(t, { clock, assembly, tenant }, ctx, input),
  });
  let billingKeys = options.billingKeyring;
  const purchaseDeps: BillingPurchaseDeps = {
    ...(env.WECHAT_PAY
      ? {
          wechatPay: {
            provider: providers.wechatPay,
            appid: env.WECHAT_PAY.appid,
            mchid: env.WECHAT_PAY.mchid,
            currentOpenid: (t, session) => currentSessionOpenid(t, session, env.WECHAT_PAY!.appid),
          },
        }
      : {}),
    tx,
    clock,
    assembly,
    config,
    flow,
    events,
    timers,
    bizNo,
    media,
    ledger,
    payment: createPayment({
      clock,
      events,
      flow,
      timers,
      bizNo,
      fulfillment: createFulfillment({ clock, events }),
    }),
    approval,
    docs: docsServices.docs,
    tenant,
    keyring: () => (billingKeys ??= loadKeyring(env)),
    sla: createSla({ clock, assembly }),
  };
  const invoiceDeps = {
    ...purchaseDeps,
    invoiceMedia: media,
    invoiceMailEnabled: notify.invoiceMailEnabled,
    resendMail: notify.resendInvoiceMail,
  };
  const billing = {
    ...createBillingPurchase(purchaseDeps),
    invoices: createInvoices(invoiceDeps),
    financeConfig: createFinanceConfigService(purchaseDeps),
  };
  invoiceScope.attach(invoiceDeps);
  transferReviewScope.attach(purchaseDeps);
  const unbindPaymentChannel = bindPaymentChannel(billing.wechatChannel);
  const order = createOrderService({
    tx,
    clock,
    assembly,
    config,
    events,
    timers,
    bizNo,
    media,
    ledger,
    content,
    docs: docsServices.docs,
  });
  let staffAuth: StaffAuth | undefined;
  let staffRoles: ReturnType<typeof createRoleManagement> | undefined;
  let staffSelfSecurity: ReturnType<typeof createStaffSelfSecurity> | undefined;
  const auditRead = createAuditRead(prisma);
  const piiReveal = createPiiReveal({
    db: prisma,
    tx,
    clock,
    keyring: () => loadKeyring(env),
    facts: piiFieldsOf(assembly),
    alerts: alertsOf(assembly),
  });

  // 连库一项加移交表第 1 行的四个自检：security 的加解密与盲索引、审计 target_type 对表名单、聚合类型对表名单、
  // machine 与 state_field 对库里的表与列
  let notifyDatabaseConnected = false;
  const startupChecks: StartupCheck[] = createStartupChecks({
    db: prisma,
    appEnv: env.APP_ENV,
    keys: env,
    warn: (message) => logger.warn({ evt: "startup.check_skipped" }, message),
  }).map((check) =>
    check.name !== "db.connect"
      ? check
      : {
          ...check,
          async run() {
            notifyDatabaseConnected = false;
            const issues = await check.run();
            notifyDatabaseConnected = issues.length === 0;
            return issues;
          },
        },
  );
  // 后台登录的三把密钥（W1-01a）：只有 api 进程签票据、建会话。没配：stg、prod 下不过；local、test 下放行并记一条告警
  if (entry === "api") {
    startupChecks.push({
      name: "security.auth_keys",
      run() {
        if (env.AUTH_KEYS === undefined && (env.APP_ENV === "local" || env.APP_ENV === "test")) {
          logger.warn(
            { evt: "startup.check_skipped" },
            "没有配置后台登录的密钥（AUTH_KEYS_FILE）：密钥的启动自检没跑，后台登录用不了",
          );
          return Promise.resolve([]);
        }
        // 没配、不合格、自检不过都抛 SecurityError：消息只说哪一项不合格，不带密钥内容
        loadAuthKeys(env);
        return Promise.resolve([]);
      },
    });
  }

  startupChecks.push({
    name: "notify.templates",
    async run() {
      if (notifyDatabaseConnected) await notify.validateConfiguration();
      return [];
    },
  });

  let closing: Promise<void> | undefined;
  const serverErrors = options.serverErrorRoot
    ? createServerErrorReporter({
        component: entry,
        release: version,
        artifactRoot: options.serverErrorRoot,
        dsn: env.SERVER_ERRORS?.[entry]?.dsn,
        clock,
        logger,
      })
    : undefined;
  return {
    sessionMutex,
    docs: docsServices.docs,
    docsAdmin: docsServices.admin,
    documentConverter,
    smsInit: createSmsInit({ tx, clock }),
    analytics,
    subscribeResults,
    clientErrors,
    ...(serverErrors ? { serverErrors } : {}),
    webhooks,
    order,
    billing,
    billingParameters: createParameterChanges({
      tx,
      clock,
      staffBriefs,
      events,
      notices: createNotices({ clock, events }),
      candidates: readTemplatePriceCandidates,
    }),
    billingPlansAdmin: createPlanAdmin({
      tx,
      clock,
      staffBriefs,
      events,
      notices: createNotices({ clock, events }),
    }),
    notifyMessages,
    notify,
    staffManagement,
    followUps: createStaffFollowUps({ tx, clock, assembly }),
    content,
    contentAdmin,
    media,
    entry,
    env,
    version,
    logger,
    clock,
    tx,
    bizNo,
    approval,
    config,
    configAdmin,
    siteAdmin,
    calendarAdmin,
    health,
    rateLimiter,
    assembly,
    providers,
    events,
    timers,
    report,
    startupChecks,
    close() {
      return (closing ??= (async () => {
        const mutexClosing = sessionMutex.close();
        void mutexClosing.catch(() => undefined);
        let failure: PromiseRejectedResult | undefined;
        const settle = async (closes: readonly (() => unknown)[]) => {
          const results = await Promise.allSettled(
            closes.map((close) => Promise.resolve().then(close)),
          );
          failure ??= results.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
        };
        await settle([
          () => modelBudget?.disable(),
          () => {
            entitlementScope.close();
            invitationScope.close();
          },
        ]);
        await settle([() => docsScope.close(), () => documentConverter?.close()]);
        await settle([
          () => staffScope.close(),
          () => media.jobs.shutdown(),
          () => analyticsScope.close(),
          () => notifyScope.close(),
          () => billingDailyScope.close(),
        ]);
        await settle([() => modelDrivers?.close()]);
        await settle([() => modelBudget?.close()]);
        await settle([
          () => invoiceScope.close(),
          () => transferReviewScope.close(),
          () => mediaAssetsScope.close(),
          () => profileConsistencyScope.close(),
          () => mediaScope.close(),
          () => contentPricingScope.close(),
          () => deliveryProductionScope.close(),
          () => deliverySlaScope.close(),
          () => mediaProduction.close(),
          unbindNoticeLink,
          ...wechatClosers,
          () => clientErrors.close(),
          () => serverErrors?.close(),
        ]);
        await settle([
          unbindOrderStart,
          unbindOrder,
          unbindBilling,
          unbindPaymentChannel,
          unbindContent,
          unbindPublish,
          unbindDelivery,
          unbindApprovalSla,
          unbindCalendarCoverage,
          unbindOps,
          unbindWebhooks,
        ]);
        await settle([() => mediaChannel.close()]);
        await settle([() => mutexClosing]);
        await settle([() => alertFactsScope.close()]);
        await settle([() => redis.disconnect(), () => prisma.$disconnect()]);
        if (failure) throw failure.reason;
      })());
    },
    flow,
    auditRead,
    flowOps: createFlowOps({ tx, clock }),
    alertActions: createAlertActions({ tx, clock }),
    analyticsPartitions: { repartition: analyticsScope.repartition },
    piiReveal,
    get staffRoles() {
      staffRoles ??= createRoleManagement({ db: prisma, tx, clock, roles: this.staffAuth.roles });
      return staffRoles;
    },
    get staffSelfSecurity() {
      staffSelfSecurity ??= createStaffSelfSecurity({
        db: prisma,
        tx,
        clock,
        keyring: loadKeyring(env),
        authKeys: loadAuthKeys(env),
        flags: config.flags,
        wecom: providers.wecom,
      });
      return staffSelfSecurity;
    },
    get staffAuth() {
      staffAuth ??= createStaffAuth({
        tx,
        db: prisma,
        clock,
        keyring: loadKeyring(env),
        authKeys: loadAuthKeys(env),
        flow,
        alerts: alertsOf(assembly),
      });
      return staffAuth;
    },
  };
}
