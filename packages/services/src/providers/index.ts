// Provider 的工厂与生效状态汇总（01 第 9 节；ADR-039；D7 第 7.5 节“启动校验”）。
//
// createProviders 按环境与选项给十二个接口各选一个实现，包上外呼前钩子，并把各接口的生效状态打进启动日志。
// 构建时不连网、不外呼：什么都没配也能启动。启动失败只有一种：选了只限本地的驱动而环境是 stg、prod。
// 真实驱动还没有（wechat、sms 在 G2-D；对象存储与数据万象在 G3-A；ocr、asr、llm 在 G3-C；wechatPay 在 G4-A；
// mail 在 G4-B；esign 在 G5-B；wecom 在 G7-A；invoice 属 V1.1）：下面各 select* 函数里留了位置，由那些包填。
// 领域模块不引本文件，只引 ./types.ts；驱动只在装配处（kernel）经本文件引入（D7 第 2.2 节 D8）。

import { createConsoleSms } from "./sms/console.js";
import { createMinioStorage, LOCAL_MINIO } from "./storage/minio.js";
import type { MinioConfig } from "./storage/minio.js";
import { guardProviders, PROVIDER_NAMES } from "./types.js";
import type {
  BeforeProviderCall,
  EsignProvider,
  ProviderAppEnv,
  ProviderLogger,
  ProviderName,
  Providers,
  ProviderStatus,
  SmsProvider,
  StorageProvider,
} from "./types.js";
import {
  createLocalMedia,
  createLocalWechat,
  createStampEsign,
  unconfiguredEsign,
  unconfiguredProviders,
  unconfiguredSms,
  unconfiguredStorage,
} from "./unconfigured.js";

export * from "./types.js";
export { createConsoleSms } from "./sms/console.js";
export { createMinioStorage, LOCAL_MINIO } from "./storage/minio.js";
export type { MinioConfig, MinioStorage } from "./storage/minio.js";
export {
  createLocalMedia,
  createLocalWechat,
  createStampEsign,
  LOCAL_WECHAT_PHONE,
  unconfiguredProviders,
} from "./unconfigured.js";

/**
 * 影响选哪个实现的选项。现在只有三项；真实驱动的配置由各自的包加在这里。
 * 它们从哪些环境变量来、怎样并进 loadEnv 与 .env.example，本包没有做，原因见 README.md“环境变量”一节。
 */
export interface ProviderSettings {
  sms?: {
    /** 显式选控制台短信。不写时：local、test 用控制台输出，stg、prod 为未配置 */
    driver?: "console";
  };
  storage?: {
    /** 显式选本地 MinIO。不写时：local、test 用本地 MinIO，stg、prod 为未配置 */
    driver?: "minio";
    /** 覆盖本地 MinIO 的连接参数；不写用 infra/compose/local.yml 那一套 */
    minio?: Partial<MinioConfig>;
  };
  esign?: {
    /** 图片章开关。stg、prod 下没配电子签时，只有它为 true 才用图片章（须法务书面同意，ADR-039 的例外） */
    imageSeal?: boolean;
  };
}

export interface CreateProvidersOptions {
  appEnv: ProviderAppEnv;
  logger: ProviderLogger;
  settings?: ProviderSettings;
  /** 外呼前钩子；缺省空转。W0-20 接上 kernel 的事务标记 */
  beforeCall?: BeforeProviderCall;
}

/** 选项与环境对不上：启动即失败。message 只写接口名与原因，不带任何配置值 */
export class ProviderConfigError extends Error {
  readonly provider: ProviderName;

  constructor(provider: ProviderName, reason: string) {
    super(`Provider 配置不合格（${provider}）：${reason}`);
    this.name = "ProviderConfigError";
    this.provider = provider;
  }
}

/** 只限本地的落点（控制台短信、本地 MinIO、假微信、媒体小文件通道）可以用的环境 */
function isLocalEnv(appEnv: ProviderAppEnv): boolean {
  return appEnv === "local" || appEnv === "test";
}

function selectSms(
  appEnv: ProviderAppEnv,
  settings: ProviderSettings,
  logger: ProviderLogger,
): SmsProvider {
  const driver: string | undefined = settings.sms?.driver;
  if (driver !== undefined && driver !== "console") {
    throw new ProviderConfigError("sms", "不认识的驱动；现在只有 console");
  }
  if (driver === "console" && !isLocalEnv(appEnv)) {
    throw new ProviderConfigError("sms", `控制台短信只限 local、test，${appEnv} 不能选它`);
  }
  // 真实驱动（腾讯云短信）的位置：G2-D
  return isLocalEnv(appEnv) ? createConsoleSms({ logger }) : unconfiguredSms;
}

function selectStorage(appEnv: ProviderAppEnv, settings: ProviderSettings): StorageProvider {
  const driver: string | undefined = settings.storage?.driver;
  if (driver !== undefined && driver !== "minio") {
    throw new ProviderConfigError("storage", "不认识的驱动；现在只有 minio");
  }
  if (driver === "minio" && !isLocalEnv(appEnv)) {
    throw new ProviderConfigError("storage", `本地 MinIO 只限 local、test，${appEnv} 不能选它`);
  }
  // 真实驱动（腾讯云 COS）的位置：G3-A
  if (!isLocalEnv(appEnv)) return unconfiguredStorage;
  return createMinioStorage({ ...LOCAL_MINIO, ...settings.storage?.minio });
}

function selectEsign(
  appEnv: ProviderAppEnv,
  settings: ProviderSettings,
  logger: ProviderLogger,
): EsignProvider {
  // 真实驱动（机构数字证书签署）的位置：G5-B
  if (isLocalEnv(appEnv)) return createStampEsign();
  if (settings.esign?.imageSeal !== true) return unconfiguredEsign;
  logger.warn(
    { provider: "esign" },
    "电子签没有配置，图片章开关已打开：授权书只盖图片章，没有数字签名。须有法务书面同意（ADR-039）",
  );
  return createStampEsign();
}

export interface ProviderStatusEntry {
  name: ProviderName;
  status: ProviderStatus;
  configured: boolean;
}

/** 十二个接口的生效状态，顺序照 ADR-039 */
export function describeProviders(providers: Providers): ProviderStatusEntry[] {
  return PROVIDER_NAMES.map((name) => ({
    name,
    status: providers[name].status,
    configured: providers[name].configured,
  }));
}

/**
 * 把生效状态打进日志：十二个接口各一行（接口名加生效状态），最后一行 providers ready 汇总。
 * 只打状态，不打任何配置值；这几行是核对线上配置的事实源（D7 第 7.5 节）。
 */
export function logProviderStatus(logger: ProviderLogger, providers: Providers): void {
  const entries = describeProviders(providers);
  for (const { name, status } of entries) {
    logger.info({ provider: name, status }, `provider ${name}: ${status}`);
  }
  logger.info(
    { providers: Object.fromEntries(entries.map(({ name, status }) => [name, status])) },
    "providers ready",
  );
}

const noop: BeforeProviderCall = () => {};

/**
 * 按环境与选项装配十二个 Provider，并打印生效状态。
 * 什么都不给时（01 第 9 节“未配置时”一列）：
 *   local、test  wechat 假实现；wechatPay 未配置（只剩对公转账）；sms 控制台；storage 本地 MinIO；
 *                media 小文件通道；esign 图片章；其余未配置
 *   stg、prod    十二个都是未配置；esign 的图片章要显式开关
 */
export function createProviders(options: CreateProvidersOptions): Providers {
  const { appEnv, logger } = options;
  const settings = options.settings ?? {};
  const local = isLocalEnv(appEnv);

  const chosen: Providers = {
    ...unconfiguredProviders,
    // 真实驱动的位置：wechat 在 G2-D；media（数据万象）在 G3-A
    wechat: local ? createLocalWechat({ logger }) : unconfiguredProviders.wechat,
    sms: selectSms(appEnv, settings, logger),
    storage: selectStorage(appEnv, settings),
    media: local ? createLocalMedia() : unconfiguredProviders.media,
    esign: selectEsign(appEnv, settings, logger),
    // wechatPay（G4-A）、ocr、asr、llm（G3-C）、wecom（G7-A）、mail（G4-B）、invoice（V1.1）：
    // 真实驱动没到之前一律未配置
  };

  const providers = guardProviders(chosen, options.beforeCall ?? noop);
  logProviderStatus(logger, providers);
  return providers;
}
