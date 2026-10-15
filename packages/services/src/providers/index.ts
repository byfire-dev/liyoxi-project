// Provider 的工厂与生效状态汇总（01 第 9 节；ADR-039；D7 第 7.5 节“启动校验”）。
//
// createProviders 按环境与选项给十二个接口各选一个实现，包上外呼前钩子，并把各接口的生效状态打进启动日志。
// 构建时不连网、不外呼：什么都没配也能启动。显式驱动须完整配置并交由调用者登记关闭。
// 领域模块不引本文件，只引 ./types.ts；驱动只在装配处（kernel）经本文件引入（D7 第 2.2 节 D8）。

import { createWechatPay } from "./wechat-pay/driver.js";
import type { WechatPayDriverDeps } from "./wechat-pay/driver.js";
import type { WechatPaySettings } from "./wechat-pay/config.js";
import { createTencentSms } from "./sms/tencent.js";
import type { TencentSmsOptions } from "./sms/tencent.js";
import { createConsoleSms } from "./sms/console.js";
import type { Redis } from "ioredis";
import { createWechatDriver } from "./wechat/driver.js";
import { createRedisTokenCache } from "./wechat/token.js";
import { createCiMedia } from "./media/ci.js";
import type { CiConfig } from "./media/ci.js";
import { createCosStorage } from "./storage/cos.js";
import type { CosConfig } from "./storage/cos.js";
import { createMinioStorage, LOCAL_MINIO } from "./storage/minio.js";
import type { MinioConfig } from "./storage/minio.js";
import { createTencentAsr } from "./asr/tencent.js";
import type { TencentAsrConfig, TencentAsrOptions } from "./asr/tencent.js";
import { createDomesticLlm } from "./llm/driver.js";
import type { DomesticLlmConfig, DomesticLlmOptions } from "./llm/driver.js";
import { createTencentOcr } from "./ocr/tencent.js";
import type { TencentOcrConfig, TencentOcrOptions } from "./ocr/tencent.js";
import { createWecomRobot } from "./wecom/robot.js";
import type { WecomRobotConfig, WecomRobotOptions } from "./wecom/robot.js";
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
export { createWechatPay } from "./wechat-pay/driver.js";
export type { WechatPaySettings } from "./wechat-pay/config.js";
export { createWecomRobot } from "./wecom/robot.js";
export type { WecomRobotConfig, WecomRobotOptions } from "./wecom/robot.js";
// 备份替身复用同一有界协议边界，经正式入口消费，不跨模块引驱动私有叶。
export {
  createBackupStorage,
  validBackupTarget,
  backupObjectKey,
} from "./storage/backup-stream.js";
export type { BackupTransport } from "./storage/backup-stream.js";
export { createTencentAsr } from "./asr/tencent.js";
export { createTencentOcr } from "./ocr/tencent.js";
export type { TencentOcrConfig, TencentOcrOptions } from "./ocr/tencent.js";
export { createDomesticLlm } from "./llm/driver.js";
export type { DomesticLlmConfig, DomesticLlmOptions, LlmEndpoint } from "./llm/driver.js";
export type { TencentAsrConfig, TencentAsrOptions } from "./asr/tencent.js";
export { createProductionMediaTools } from "./mediatool/production.js";
export { createMediaToolClient } from "./mediatool/client.js";
export { createMediaWorkspace } from "./mediatool/work-io.js";
export type { ProductionMediaTools } from "./types.js";
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
 * 影响选哪个实现的选项；真实驱动的配置由各自的包声明。
 * 它们从哪些环境变量来、怎样并进 loadEnv 与 .env.example，本包没有做，原因见 README.md“环境变量”一节。
 */
export interface ProviderSettings {
  wechatPay?: WechatPaySettings;
  wecomRobot?: WecomRobotConfig;
  wechat?: { appid: string; secret: string };
  media?: { ci: CiConfig };
  asr?: TencentAsrConfig;
  ocr?: TencentOcrConfig;
  llm?: DomesticLlmConfig;
  sms?: {
    /** 显式选控制台短信。不写时：local、test 用控制台输出，stg、prod 为未配置 */
    driver?: "console" | "tencent";
    tencent?: TencentSmsOptions;
  };
  storage?: {
    /** 显式选本地 MinIO。不写时：local、test 用本地 MinIO，stg、prod 为未配置 */
    driver?: "minio" | "cos";
    cos?: CosConfig;
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
  wechatPay?: WechatPayDriverDeps;
  asr?: TencentAsrOptions & { registerClose: (close: () => Promise<void>) => void };
  ocr?: TencentOcrOptions & { registerClose: (close: () => Promise<void>) => void };
  llm?: DomesticLlmOptions & { registerClose: (close: () => Promise<void>) => void };
  wecomRobot?: WecomRobotOptions & { registerClose: (close: () => Promise<void>) => void };
  media?: {
    now: () => Date;
    registerClose: (close: () => Promise<void>) => void;
    fetchImpl?: typeof fetch;
  };
  storage?: {
    now: () => Date;
    registerClose: (close: () => Promise<void>) => void;
    fetchImpl?: typeof fetch;
  };
  /** 借用进程连接；只登记本工厂创建的驱动的关闭函数。 */
  wechat?: {
    redis: Pick<Redis, "get" | "set" | "eval"> & { options: { keyPrefix?: string } };
    prefix: string;
    now: () => Date;
    registerClose: (close: () => Promise<void>) => void;
    fetchImpl?: typeof fetch;
  };
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
  if (driver !== undefined && driver !== "console" && driver !== "tencent") {
    throw new ProviderConfigError("sms", "不认识的驱动；只接受 console、tencent");
  }
  if (driver === "console" && !isLocalEnv(appEnv)) {
    throw new ProviderConfigError("sms", `控制台短信只限 local、test，${appEnv} 不能选它`);
  }
  if (driver === "tencent") {
    const config = settings.sms?.tencent;
    if (
      !config ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(config.config.secretId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(config.config.secretKey) ||
      !/^\d{1,20}$/.test(config.config.sdkAppId) ||
      !/^ap-[a-z]+(?:-[a-z]+)*$/.test(config.config.region)
    ) {
      throw new ProviderConfigError("sms", "腾讯云配置须成组且格式合法");
    }
    return createTencentSms(config);
  }
  return isLocalEnv(appEnv) ? createConsoleSms({ logger }) : unconfiguredSms;
}

function selectStorage(appEnv: ProviderAppEnv, settings: ProviderSettings): StorageProvider {
  const driver: string | undefined = settings.storage?.driver;
  if (driver !== undefined && driver !== "minio" && driver !== "cos") {
    throw new ProviderConfigError("storage", "不认识的驱动；现在只有 minio");
  }
  if (driver === "cos") return unconfiguredStorage;
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
  if ((settings.wechat === undefined) !== (options.wechat === undefined))
    throw new ProviderConfigError("wechat", "完整配置与运行时依赖须同时提供");
  if (
    (settings.storage?.cos === undefined) !== (options.storage === undefined) ||
    (settings.storage?.driver === "cos" && !settings.storage.cos)
  )
    throw new ProviderConfigError("storage", "COS 完整配置与运行时依赖须同时提供");

  if ((settings.media === undefined) !== (options.media === undefined))
    throw new ProviderConfigError("media", "CI配置与自有生命周期须同时提供");
  if ((settings.asr === undefined) !== (options.asr === undefined))
    throw new ProviderConfigError("asr", "完整配置与自有生命周期须同时提供");
  if ((settings.ocr === undefined) !== (options.ocr === undefined))
    throw new ProviderConfigError("ocr", "完整配置与自有生命周期须同时提供");
  if (options.ocr !== undefined && typeof options.ocr.registerClose !== "function")
    throw new ProviderConfigError("ocr", "须提供关闭登记函数");
  if (
    options.asr !== undefined &&
    (typeof options.asr?.now !== "function" || typeof options.asr?.registerClose !== "function")
  )
    throw new ProviderConfigError("asr", "须提供时钟与关闭登记函数");
  if ((settings.llm === undefined) !== (options.llm === undefined))
    throw new ProviderConfigError("llm", "完整配置与自有生命周期须同时提供");
  if (options.llm !== undefined && typeof options.llm?.registerClose !== "function")
    throw new ProviderConfigError("llm", "须提供关闭登记函数");
  if ((settings.wecomRobot === undefined) !== (options.wecomRobot === undefined))
    throw new ProviderConfigError("wecom", "机器人完整配置与自有生命周期须同时提供");
  if (options.wecomRobot !== undefined && typeof options.wecomRobot.registerClose !== "function")
    throw new ProviderConfigError("wecom", "机器人须提供关闭登记函数");
  if ((settings.wechatPay === undefined) !== (options.wechatPay === undefined))
    throw new ProviderConfigError("wechatPay", "完整配置与运行时依赖须同时提供");
  const chosen: Providers = {
    ...unconfiguredProviders,
    // 真实驱动的位置：wechat 在 G2-D；media（数据万象）在 G3-A
    wechat: local ? createLocalWechat({ logger }) : unconfiguredProviders.wechat,
    sms: selectSms(appEnv, settings, logger),
    storage: selectStorage(appEnv, settings),
    media: local ? createLocalMedia() : unconfiguredProviders.media,
    esign: selectEsign(appEnv, settings, logger),
    // wecom（除机器人）、mail（G4-B）、invoice（V1.1）：
    // 真实驱动没到之前一律未配置
  };

  if (settings.wechatPay && options.wechatPay)
    chosen.wechatPay = createWechatPay(settings.wechatPay, options.wechatPay);
  if (settings.wechat && options.wechat) {
    const transport = options.wechat;
    const driver = createWechatDriver(
      {
        ...settings.wechat,
        releaseChannel: local ? "develop" : appEnv === "stg" ? "trial" : "release",
      },
      {
        cache: createRedisTokenCache(transport.redis, transport.prefix),
        now: transport.now,
        fetchImpl: transport.fetchImpl,
      },
    );
    transport.registerClose(driver.close);
    chosen.wechat = driver.provider;
  }
  if (settings.storage?.cos && options.storage) {
    if (settings.storage.driver !== "cos") throw new TypeError("COS 配置与驱动选择不一致");
    const driver = createCosStorage(settings.storage.cos, options.storage);
    chosen.storage = driver;
    options.storage.registerClose(driver.close);
  }

  if (settings.media && options.media) {
    const driver = createCiMedia(settings.media.ci, options.media);
    chosen.media = driver.provider;
    options.media.registerClose(driver.close);
  }
  if (settings.asr !== undefined && options.asr !== undefined) {
    const driver = createTencentAsr(settings.asr, options.asr);
    options.asr.registerClose(driver.close);
    chosen.asr = driver.provider;
  }
  if (settings.ocr !== undefined && options.ocr !== undefined) {
    const driver = createTencentOcr(settings.ocr, options.ocr);
    options.ocr.registerClose(driver.close);
    chosen.ocr = driver.provider;
  }
  if (settings.llm !== undefined && options.llm !== undefined) {
    const driver = createDomesticLlm(settings.llm, options.llm);
    options.llm.registerClose(driver.close);
    chosen.llm = driver.provider;
  }
  if (settings.wecomRobot !== undefined && options.wecomRobot !== undefined) {
    const driver = createWecomRobot(settings.wecomRobot, options.wecomRobot);
    options.wecomRobot.registerClose(driver.close);
    chosen.wecom = {
      ...unconfiguredProviders.wecom,
      capabilities: { robot: true },
      sendRobotMessage: driver.sendRobotMessage,
    };
  }
  const providers = guardProviders(chosen, options.beforeCall ?? noop);
  logProviderStatus(logger, providers);
  return providers;
}
