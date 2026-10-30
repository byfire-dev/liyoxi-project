// 环境变量的唯一入口（D7 第 2.5、7.5 节）：全部配置只经 loadEnv() 的 Zod 校验，缺项或写错即抛错。
//
// 规则（W0-03 任务书 第 11 节第 2、3 项）：
//   1. 空串、只有空白的值，当没填。
//   2. 连接串 DATABASE_URL、REDIS_URL 是敏感项、必填。APP_ENV 为 local、test 时可以给明文；
//      stg、prod 只认 *_FILE（值是文件路径，文件里放连接串），给了明文即失败。
//   3. 报错逐条是“键名: 原因”，不带任何值（值、文件路径、文件内容都不出现）。
//   4. 成组的变量成对校验：配了一部分即失败（groupIssues）。第一版没有成组变量，后续包往 ENV_GROUPS 里加。
//   5. 字段加密与盲索引的两份密钥文件（W0-14；D4 第 9.2 节、附录 C；D7 第 7.5 节）任何环境都只认 *_FILE：
//      给了明文变量 DATA_KEYS、BIDX_KEYS 即失败。两份成组；都不配时 Env 里没有这两项，要用密钥的进程
//      靠启动自检拦（security 的 selfCheck）。这里只校验文件的形状，用途齐不齐、密钥重不重复由密钥环校验。
//   6. 后台登录的三把密钥（W1-01a；D4 第 6.3、9.2 节）放一份文件 AUTH_KEYS_FILE：票据签名、设备 Cookie 签名、
//      动态口令密钥的加密（MFA，带 kid 可轮换）。写法同规则 5：只认文件路径，给明文变量 AUTH_KEYS 即失败；
//      不配时 Env 里没有这一项，要用它的进程靠启动自检拦（security 的 loadAuthKeys）。
// 后续包加变量：在这里加键与校验，同 PR 改 .env.example（node infra/ci/check-env-example.mjs 核对键集合）。
// 本文件不写相对导入：infra/ci/check-env-example.mjs 用 Node 自带的类型擦除直接加载它。

import { createPrivateKey, X509Certificate } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { isAbsolute, normalize } from "node:path";

import { z } from "zod";

export const APP_ENVS = ["local", "test", "stg", "prod"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** 连接串可以给明文的环境；其余环境只认 *_FILE */
const PLAINTEXT_ENVS: readonly string[] = ["local", "test"];

/** 敏感的连接串：键名 → 允许的协议 */
const CONNECTION_KEYS = {
  DATABASE_URL: ["postgresql:", "postgres:"],
  REDIS_URL: ["redis:", "rediss:"],
} as const;
type ConnectionKey = keyof typeof CONNECTION_KEYS;

/** loadEnv 读的全部键名；.env.example 的键集合须与它相等 */
export const ENV_KEYS: readonly string[] = [
  "APP_ENV",
  "LOG_LEVEL",
  "DATABASE_URL",
  "DATABASE_URL_FILE",
  "REDIS_URL",
  "REDIS_URL_FILE",
  "MINIO_ENDPOINT",
  "MINIO_PUBLIC_ENDPOINT",
  "DATA_KEYS_FILE",
  "BIDX_KEYS_FILE",
  "AUTH_KEYS_FILE",
  "ADMIN_IP_ALLOWLIST",
  "CERT_DOMAINS",
  "PORTAL_PUBLIC_ORIGIN",
  "LYX_PDF_FONT_DIR",
  "ESIGN_SSM_REGION",
  "ESIGN_SSM_SECRET_NAME",
  "ESIGN_SSM_VERSION_ID",
  "ESIGN_SSM_STS_CREDENTIALS_FILE",
  "STAGING_PAY_ENTITY_IDS",
  "BACKUP_FILE",
  "ALERTS_FILE",
  "SMS_SECRET_ID_FILE",
  "SMS_SECRET_KEY_FILE",
  "SMS_SDK_APP_ID",
  "SMS_REGION",
  "WECHAT_PAY_FILE",
  "WECHAT_APPID",
  "WECHAT_SECRET_FILE",
  "WECHAT_MESSAGE_TOKEN_FILE",
  "WECHAT_MESSAGE_AES_KEY_FILE",
  "CLIENT_ERROR_PROJECTS_FILE",
  "SERVER_ERRORS_FILE",
  "COS_REGION",
  "COS_BUCKET_SECURE",
  "COS_BUCKET_ASSET",
  "COS_BUCKET_MEDIA",
  "COS_BUCKET_PUB",
  "COS_SIGNER_KEYS_FILE",
  "COS_STS_ISSUER_KEYS_FILE",
  "COS_WORKER_KEYS_FILE",
  "CI_REGION",
  "CI_BUCKET_SECURE",
  "CI_BUCKET_ASSET",
  "CI_BUCKET_MEDIA",
  "CI_BUCKET_PUB",
  "CI_WORKER_KEYS_FILE",
  "CI_CALLBACK_KEY_FILE",
  "CI_CALLBACK_ORIGIN",
  "MEDIA_PRODUCTION_FILE",
  "ASR_TENCENT_FILE",
  "OCR_TENCENT_FILE",
  "MAIL_TENCENT_FILE",
  "LLM_DOMESTIC_FILE",
  "ASR_CALLBACK_ORIGIN",
  "ASR_CALLBACK_KEY_FILE",
];

/** 数据加密密钥文件的内容：current 是当前 kid，keys 是 kid → base64 写的 32 字节 */
export interface DataKeysConfig {
  readonly current: string;
  readonly keys: Readonly<Record<string, string>>;
}
/** 盲索引密钥文件的内容：用途 → base64 写的 32 字节 */
export type BidxKeysConfig = Readonly<Record<string, string>>;
/** 后台登录密钥文件的内容：票据签名、设备 Cookie 签名各一把；mfa 的形状同数据密钥，可轮换 */
export interface AuthKeysConfig {
  readonly ticket: string;
  readonly device: string;
  readonly mfa: DataKeysConfig;
}

export interface SmsEnvConfig {
  readonly secretId: string;
  readonly secretKey: string;
  readonly sdkAppId: string;
  readonly region: string;
}

export interface WechatConfig {
  readonly appid: string;
  readonly secret: string;
  readonly messageToken: string;
  readonly messageEncodingAESKey: string;
}

/** 上报项目白名单与固定上游；只能来自 CLIENT_ERROR_PROJECTS_FILE。 */
export interface ClientErrorProjectsConfig {
  readonly projects: readonly { readonly dsn: string; readonly upstreamDsn?: string }[];
}

/** 两个服务端组件的独立上游；不借客户端项目白名单，默认均未配。 */
export interface ServerErrorsConfig {
  readonly api?: Readonly<{ dsn: string }>;
  readonly worker?: Readonly<{ dsn: string }>;
}

/** 备份只使用独立FILE中的只读连接与公钥；从不回退应用连接或猜测目标。 */
export interface BackupEnvConfig {
  readonly databaseUrl: string;
  readonly recipient: string;
  readonly maxBytes: number;
  readonly target: {
    readonly bucket: string;
    readonly prefix: string;
    readonly region?: string;
    readonly key?: { readonly secretId: string; readonly secretKey: string };
  };
}

/** worker专属告警配置；机器人只保存原始key，目的地由Provider固定。 */
export interface AlertsEnvConfig {
  readonly robotKey?: string;
  readonly oncallPhones: readonly string[];
  readonly p2Immediate?: readonly string[];
}

export type AsrTencentEnvConfig = z.infer<typeof AsrTencentEnvSchema>;
export type OcrTencentEnvConfig = z.infer<typeof OcrTencentEnvSchema>;
export type MailTencentEnvConfig = z.infer<typeof MailTencentEnvSchema>;
export type LlmDomesticEnvConfig = z.infer<typeof LlmDomesticEnvSchema>;

export interface WechatPayEnvConfig {
  readonly mchid: string;
  readonly merchantSerialNo: string;
  readonly merchantPrivateKeyPem: string;
  readonly apiV3Key: string;
  readonly publicKeyId: string;
  readonly publicKeyPem: string;
  readonly appid: string;
  readonly notifyUrl: string;
  /** 只由可选商户API证书PEM验证后派生，源JSON不得直接填写。 */
  readonly merchantCertificateExpiresAt?: string;
}

const WechatPayEnvSchema = z
  .object({
    mchid: z.string().regex(/^\d{6,20}$/),
    merchantSerialNo: z.string().regex(/^[0-9A-Fa-f]{1,64}$/),
    merchantPrivateKeyPem: z.string().min(1),
    merchantCertificatePem: z.string().min(1).optional(),
    apiV3Key: z.string().refine((v) => Buffer.byteLength(v.trim()) === 32),
    publicKeyId: z.string().regex(/^PUB_KEY_ID_[A-Za-z0-9]+$/),
    publicKeyPem: z.string().min(1),
    appid: z.string().regex(/^wx[A-Za-z0-9]{16}$/),
    notifyUrl: z.url().refine((v) => {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
    }),
  })
  .strict();

function readWechatPay(source: EnvSource, issues: EnvIssue[]): WechatPayEnvConfig | undefined {
  // RSA私钥与公钥合并后可能超过4KiB，复用已有JSON密钥读取；错误仅投影字段名。
  return readKeyFile(source, "WECHAT_PAY", issues, (json) => {
    const parsed = WechatPayEnvSchema.safeParse(json);
    if (!parsed.success)
      return `配置字段不完整或不合法：${[...new Set(parsed.error.issues.map((i) => i.path.join(".") || "WECHAT_PAY"))].join("、")}`;
    const { merchantCertificatePem, ...config } = parsed.data;
    if (merchantCertificatePem === undefined) return config;
    try {
      const certificate = new X509Certificate(merchantCertificatePem);
      const serial = (value: string) => value.toUpperCase().replace(/^0+/, "") || "0";
      if (
        serial(certificate.serialNumber) !== serial(config.merchantSerialNo) ||
        !certificate.checkPrivateKey(createPrivateKey(config.merchantPrivateKeyPem))
      )
        return "merchantCertificatePem：证书序列号或公钥与商户配置不匹配";
      // 只投影证书自身期限；不推测有效期、不联网验证、不把PEM转交给健康读侧。
      return {
        ...config,
        merchantCertificateExpiresAt: new Date(certificate.validTo).toISOString(),
      };
    } catch {
      return "merchantCertificatePem：证书或商户私钥格式不合法";
    }
  });
}

export interface EsignSsmEnvConfig {
  readonly region: string;
  readonly secretName: string;
  readonly versionId: string;
  readonly stsCredentialsFile: string;
}

export interface Env {
  /** Description only: loadEnv never opens the worker STS credential file. */
  readonly ESIGN_SSM?: EsignSsmEnvConfig;
  readonly LYX_PDF_FONT_DIR?: string;
  readonly WECHAT_PAY?: WechatPayEnvConfig;
  /** 独立可选的严格模型配置；本片只解析，不装配或启用驱动。 */
  readonly ASR_TENCENT?: AsrTencentEnvConfig;
  /** 同步证照识别独立配置；只由 API 组合根消费。 */
  readonly OCR_TENCENT?: OcrTencentEnvConfig;
  /** 独立邮件FILE；只允许worker装配发送，API/check-env不获得发送driver。 */
  readonly MAIL_TENCENT?: MailTencentEnvConfig;
  readonly LLM_DOMESTIC?: LlmDomesticEnvConfig;
  /** 独立可选回调；密钥保留 FILE 的原始 UTF8 字节，只解析、不装配。 */
  readonly ASR_CALLBACK?: Readonly<{ origin: string; key: string }>;
  readonly MEDIA_PRODUCTION?:
    | {
        readonly workDir: string;
        readonly socketPath: string;
        readonly aigc: {
          readonly Label: string;
          readonly ContentProducer: string;
          readonly ReservedCode1: string;
          readonly ContentPropagator: string;
          readonly ReservedCode2: string;
        };
        readonly templates: {
          readonly normalize: string;
          readonly sd: string;
          readonly hd: string;
          readonly sample: string;
          readonly brand: string;
          readonly ai: string;
        };
      }
    | {
        readonly mode: "probe_only" | "local_sample_watermark";
        readonly workDir: string;
        readonly socketPath: string;
      };
  readonly APP_ENV: AppEnv;
  readonly LOG_LEVEL: LogLevel;
  readonly DATABASE_URL: string;
  readonly REDIS_URL: string;
  /** 本地 MinIO 的服务端地址与客户端签名地址；独立可选，只允许 local、test。 */
  readonly MINIO?: { readonly endpoint?: string; readonly publicEndpoint?: string };
  readonly COS?: {
    readonly region: string;
    readonly buckets: Readonly<Record<"secure" | "asset" | "media" | "pub", string>>;
    readonly signer?: { readonly secretId: string; readonly secretKey: string };
    readonly stsIssuer?: { readonly secretId: string; readonly secretKey: string };
    readonly worker?: { readonly secretId: string; readonly secretKey: string };
  };
  readonly CI?: {
    readonly callback: { readonly key: string; readonly origin: string };
    readonly worker?: {
      readonly region: string;
      readonly buckets: Readonly<Record<"secure" | "asset" | "media" | "pub", string>>;
      readonly secretId: string;
      readonly secretKey: string;
    };
  };
  /** 数据加密密钥；两份密钥文件都没配时没有这一项 */
  readonly DATA_KEYS?: DataKeysConfig;
  /** 盲索引密钥；同上 */
  readonly BIDX_KEYS?: BidxKeysConfig;
  /** 后台登录的三把密钥；没配 AUTH_KEYS_FILE 时没有这一项 */
  readonly AUTH_KEYS?: AuthKeysConfig;
  /** 未配或空白时不限制后台来源；非空列表在认证前执行。 */
  readonly ADMIN_IP_ALLOWLIST?: readonly string[];
  /** 仅显式域名的 TLS 证书检查；缺配不会猜测部署域名。 */
  readonly CERT_DOMAINS?: readonly string[];
  /** 授权书版次的验真链接根地址；缺配不推导域名，创建快照时由文书服务受控拒绝。 */
  readonly PORTAL_PUBLIC_ORIGIN?: string;
  /** 仅预发显式候选主体；配置名单不启用自动退款或任何资金动作。 */
  readonly STAGING_PAY?: Readonly<{ entityIds: readonly string[] }>;
  readonly BACKUP?: BackupEnvConfig;
  readonly ALERTS?: AlertsEnvConfig;
  readonly SMS?: SmsEnvConfig;
  /** 整组未配置时没有此项；敏感字段只能从 FILE 读取。 */
  readonly WECHAT?: WechatConfig;
  readonly CLIENT_ERROR_PROJECTS?: ClientErrorProjectsConfig;
  readonly SERVER_ERRORS?: ServerErrorsConfig;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface EnvIssue {
  /** 环境变量的键名 */
  key: string;
  /** 原因；不含任何值 */
  reason: string;
}

/** 一组要么全配、要么全不配的变量（如微信支付的商户号、证书序列号、私钥、APIv3 密钥） */
export interface EnvGroup {
  name: string;
  keys: readonly string[];
}

/** 成组变量的登记处；后续包加变量时往这里加组 */
const WECHAT_GROUP: EnvGroup = {
  name: "微信小程序与唯一消息接收地址",
  keys: [
    "WECHAT_APPID",
    "WECHAT_SECRET_FILE",
    "WECHAT_MESSAGE_TOKEN_FILE",
    "WECHAT_MESSAGE_AES_KEY_FILE",
  ],
};
export const ENV_GROUPS: readonly EnvGroup[] = [
  {
    name: "腾讯云短信",
    keys: ["SMS_SECRET_ID_FILE", "SMS_SECRET_KEY_FILE", "SMS_SDK_APP_ID", "SMS_REGION"],
  },
  { name: "字段加密与盲索引密钥", keys: ["DATA_KEYS_FILE", "BIDX_KEYS_FILE"] },
  WECHAT_GROUP,
];

export class EnvError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    const lines = issues.map((issue) => `  - ${issue.key}: ${issue.reason}`);
    super(`环境变量校验失败：\n${lines.join("\n")}`);
    this.name = "EnvError";
    this.issues = issues;
  }
}

/** 取一个键的值：去掉首尾空白；空串当没填 */
function read(source: EnvSource, key: string): string | undefined {
  const value = source[key]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** 保持端点为根 URL，避免 URL 解析器把路径、反斜杠或控制字符静默归一化。 */
function isMinioEndpoint(value: string): boolean {
  if (!/^https?:\/\/[^/?#@\\\s\p{Cc}]+\/?$/iu.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0 &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function readMinio(
  source: EnvSource,
  appEnv: string | undefined,
  issues: EnvIssue[],
): Env["MINIO"] {
  const config: { endpoint?: string; publicEndpoint?: string } = {};
  for (const [key, field] of [
    ["MINIO_ENDPOINT", "endpoint"],
    ["MINIO_PUBLIC_ENDPOINT", "publicEndpoint"],
  ] as const) {
    const value = read(source, key);
    if (value === undefined) continue;
    if (!PLAINTEXT_ENVS.includes(appEnv ?? "")) {
      issues.push({ key, reason: "只允许在 local、test 环境配置" });
    } else if (!isMinioEndpoint(value)) {
      issues.push({
        key,
        reason: "须为 http(s) 根 URL，不接受账号、密码、路径、查询、片段或反斜杠",
      });
    } else {
      config[field] = value;
    }
  }
  return Object.keys(config).length > 0 ? Object.freeze(config) : undefined;
}

/**
 * 成组变量成对校验：一组里配了一部分、没配全，逐个报出缺的键。
 * 全配或全不配都不报。
 */
export function groupIssues(source: EnvSource, groups: readonly EnvGroup[]): EnvIssue[] {
  const issues: EnvIssue[] = [];
  for (const group of groups) {
    const missing = group.keys.filter((key) => read(source, key) === undefined);
    if (missing.length === 0 || missing.length === group.keys.length) continue;
    for (const key of missing) {
      const others = group.keys.filter((other) => other !== key).join("、");
      issues.push({
        key,
        reason: `与 ${others} 成组（${group.name}），这一组只配了一部分，缺这一项`,
      });
    }
  }
  return issues;
}

/** 按规则 2 取出一个连接串：明文或 *_FILE 二选一 */
function readConnection(
  source: EnvSource,
  key: ConnectionKey,
  appEnv: string | undefined,
  issues: EnvIssue[],
): string | undefined {
  const fileKey = `${key}_FILE`;
  const plain = read(source, key);
  const file = read(source, fileKey);

  if (plain !== undefined && file !== undefined) {
    issues.push({ key, reason: `与 ${fileKey} 只能给一个` });
    return undefined;
  }
  if (plain !== undefined) {
    // APP_ENV 缺失或写错时另有一条报错；这里只在确知不是 local、test 时拦明文
    if (appEnv !== undefined && (APP_ENVS as readonly string[]).includes(appEnv)) {
      if (!PLAINTEXT_ENVS.includes(appEnv)) {
        issues.push({ key, reason: `${appEnv} 环境只认 ${fileKey}，不接受明文` });
        return undefined;
      }
    }
    return plain;
  }
  if (file !== undefined) {
    let content: string;
    try {
      content = readFileSync(file, "utf8").trim();
    } catch {
      issues.push({ key: fileKey, reason: "所指的文件读不了" });
      return undefined;
    }
    if (content === "") {
      issues.push({ key: fileKey, reason: "所指的文件是空的" });
      return undefined;
    }
    return content;
  }
  issues.push({
    key,
    reason: `必填，未配置（local、test 可以直接给，其余环境给 ${fileKey}）`,
  });
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** kid 进密文的第二段，不得带冒号 */
const KID = /^[A-Za-z0-9_-]{1,32}$/;
const BIDX_PURPOSE = /^[a-z][a-z0-9_]{0,31}$/;
/** base64 或 base64url 写的 32 字节：43 个字符，标准写法末尾另有一个 = */
const isKey32 = (value: unknown): boolean =>
  typeof value === "string" &&
  /^[A-Za-z0-9+/_-]{43}=?$/.test(value) &&
  Buffer.from(value, "base64").length === 32;

/** 校验数据密钥文件的内容；不合格时返回原因（不带任何值） */
function parseDataKeys(json: unknown): DataKeysConfig | string {
  if (!isRecord(json) || typeof json.current !== "string" || !isRecord(json.keys)) {
    return "文件内容要是 { current, keys }：current 写当前 kid，keys 是 kid 到密钥的映射";
  }
  const entries = Object.entries(json.keys);
  if (entries.some(([kid]) => !KID.test(kid))) {
    return "kid 只能用字母、数字、下划线、连字符，不超过 32 个字符";
  }
  if (entries.some(([, key]) => !isKey32(key))) return "每把密钥要是 base64 写的 32 字节";
  if (!Object.hasOwn(json.keys, json.current)) return "current 指的 kid 不在 keys 里";
  return { current: json.current, keys: Object.fromEntries(entries) as Record<string, string> };
}

/** 校验盲索引密钥文件的内容；不合格时返回原因（不带任何值） */
function parseBidxKeys(json: unknown): BidxKeysConfig | string {
  const entries = isRecord(json) ? Object.entries(json) : [];
  if (entries.length === 0) return "文件内容要是“用途 → 密钥”的映射，至少一项";
  if (entries.some(([purpose]) => !BIDX_PURPOSE.test(purpose))) {
    return "用途只能是小写字母开头的小写蛇形，不超过 32 个字符";
  }
  if (entries.some(([, key]) => !isKey32(key))) return "每把密钥要是 base64 写的 32 字节";
  return Object.fromEntries(entries) as Record<string, string>;
}

/** 校验后台登录密钥文件的内容；不合格时返回原因（不带任何值） */
function parseAuthKeys(json: unknown): AuthKeysConfig | string {
  if (!isRecord(json) || !isKey32(json.ticket) || !isKey32(json.device)) {
    return "文件内容要是 { ticket, device, mfa }：ticket、device 各是 base64 写的 32 字节";
  }
  const mfa = parseDataKeys(json.mfa);
  if (typeof mfa === "string") return `mfa 一项不合格：${mfa}`;
  return { ticket: json.ticket as string, device: json.device as string, mfa };
}

/** 按规则 5、6 取出一份密钥文件：只认 *_FILE；明文变量给了即报错 */
function readKeyFile<T>(
  source: EnvSource,
  key:
    | "DATA_KEYS"
    | "BIDX_KEYS"
    | "AUTH_KEYS"
    | "CLIENT_ERROR_PROJECTS"
    | "MEDIA_PRODUCTION"
    | "WECHAT_PAY",
  issues: EnvIssue[],
  parse: (json: unknown) => T | string,
): T | undefined {
  const fileKey = `${key}_FILE`;
  if (read(source, key) !== undefined) {
    issues.push({ key, reason: `密钥只认 ${fileKey}（值是文件路径），任何环境都不接受明文` });
  }
  const file = read(source, fileKey);
  if (file === undefined) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    issues.push({ key: fileKey, reason: "所指的文件读不了" });
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    issues.push({ key: fileKey, reason: "文件内容不是合法的 JSON" });
    return undefined;
  }
  const parsed = parse(json);
  if (typeof parsed !== "string") return parsed;
  issues.push({ key: fileKey, reason: parsed });
  return undefined;
}

function readSmsSecret(
  source: EnvSource,
  key: "SMS_SECRET_ID" | "SMS_SECRET_KEY",
  issues: EnvIssue[],
): string | undefined {
  if (read(source, key) !== undefined) issues.push({ key, reason: `任何环境密钥只认 ${key}_FILE` });
  const file = read(source, `${key}_FILE`);
  if (file === undefined) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) throw new Error();
    const bytes = Buffer.alloc(4097);
    let length = 0;
    while (length < bytes.length) {
      const readLength = readSync(fd, bytes, length, bytes.length - length, null);
      if (!readLength) break;
      length += readLength;
    }
    if (length > 4096) throw new Error();
    const value = bytes.subarray(0, length).toString("utf8").trim();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new Error();
    return value;
  } catch {
    issues.push({ key: `${key}_FILE`, reason: "文件无法读取或内容格式不合格" });
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
/** DSN 只作为 FILE 白名单/固定目的地；请求中的 URL 从不成为外呼目的地。 */
function validErrorDsn(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim() || value.includes("\\")) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !!url.hostname &&
      /^[A-Za-z0-9_-]+$/.test(url.username) &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/(?:[A-Za-z0-9_-]+\/)*[0-9]+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
function parseMediaProduction(json: unknown): NonNullable<Env["MEDIA_PRODUCTION"]> | string {
  const text = z
    .string()
    .max(128)
    .regex(/^[^\p{Cc}]*$/u);
  const template = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/);
  const paths = {
    workDir: z.string().regex(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/),
    socketPath: z.string().min(1).max(512),
  };
  const full = z.strictObject({
    ...paths,
    aigc: z.strictObject({
      Label: text.min(1).max(16),
      ContentProducer: text.min(1),
      ReservedCode1: text,
      ContentPropagator: text,
      ReservedCode2: text,
    }),
    templates: z.strictObject({
      normalize: template,
      sd: template,
      hd: template,
      sample: template,
      brand: template,
      ai: template,
    }),
  });
  const probeOnly = z.strictObject({
    ...paths,
    mode: z.enum(["probe_only", "local_sample_watermark"]),
  });
  const parsed = z.union([full, probeOnly]).safeParse(json);
  if (
    !parsed.success ||
    !parsed.data.socketPath.startsWith(`${parsed.data.workDir}/.sock/`) ||
    !/^[A-Za-z0-9._-]+$/.test(parsed.data.socketPath.slice(parsed.data.workDir.length + 7))
  )
    return "制作配置须为完整主体与六模板，或显式 probe_only/local_sample_watermark；工作目录与同目录套接字须合法";
  return parsed.data;
}

function parseClientErrorProjects(json: unknown): ClientErrorProjectsConfig | string {
  if (
    !isRecord(json) ||
    Object.keys(json).some((key) => key !== "projects") ||
    !Array.isArray(json.projects) ||
    json.projects.length < 1 ||
    json.projects.length > 3
  )
    return "文件内容须为 { projects: [项目] }，项目1–3个";
  const seen = new Set<string>();
  const projects: { dsn: string; upstreamDsn?: string }[] = [];
  for (const project of json.projects) {
    if (
      !isRecord(project) ||
      Object.keys(project).some((key) => key !== "dsn" && key !== "upstreamDsn") ||
      !validErrorDsn(project.dsn) ||
      (project.upstreamDsn !== undefined && !validErrorDsn(project.upstreamDsn))
    )
      return "每个项目须给合法HTTPS DSN（公钥、数字项目），固定上游可选；不得含密码、查询或片段";
    if (seen.has(project.dsn)) return "项目白名单不得重复";
    seen.add(project.dsn);
    projects.push({
      dsn: project.dsn,
      ...(project.upstreamDsn === undefined ? {} : { upstreamDsn: project.upstreamDsn }),
    });
  }
  return { projects };
}

function hasProtocol(value: string, protocols: readonly string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** 微信敏感文本文件最多4KiB；只接受普通文件，所有诊断均不含路径/内容。 */
function readWechatFile(
  source: EnvSource,
  key: string,
  issues: EnvIssue[],
  rejectSymlink = false,
): string | undefined {
  if (read(source, key) !== undefined)
    issues.push({ key, reason: `敏感项只认 ${key}_FILE，任何环境都不接受明文` });
  const fileKey = `${key}_FILE`;
  const path = read(source, fileKey);
  if (path === undefined) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | (rejectSymlink ? constants.O_NOFOLLOW : 0),
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) {
      issues.push({ key: fileKey, reason: "须为不超过4KiB的普通文本文件" });
      return undefined;
    }
    const bytes = Buffer.alloc(4097);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > 4096) {
      issues.push({ key: fileKey, reason: "文件内容超过4KiB" });
      return undefined;
    }
    const content = bytes.subarray(0, offset);
    const value = (
      rejectSymlink
        ? new TextDecoder("utf-8", { fatal: true }).decode(content)
        : content.toString("utf8")
    ).trim();
    if (value) return value;
    issues.push({ key: fileKey, reason: "文件内容不能为空" });
  } catch {
    issues.push({ key: fileKey, reason: "所指的普通文本文件读不了" });
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        issues.push({ key: fileKey, reason: "配置文件关闭失败" });
      }
    }
  }
  return undefined;
}

// 与已接受驱动的字符串谓词等价；不把原 UTF16 长度或正则改成码点规则。
const AsrTencentEnvSchema = z
  .object({
    secretId: z.string().refine((value) => /^[A-Za-z0-9_-]{1,128}$/.test(value)),
    secretKey: z.string().refine((value) => value.length > 0 && value.length <= 256),
  })
  .strict()
  .readonly();
const OcrTencentEnvSchema = z
  .object({
    secretId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    secretKey: z.string().min(1).max(256),
    region: z.string().regex(/^ap-[a-z]+(?:-[a-z]+)*$/),
  })
  .strict()
  .readonly();
const MailTencentEnvSchema = z
  .strictObject({
    secretId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    secretKey: z.string().regex(/^[\x21-\x7e]{1,256}$/),
    region: z.enum(["ap-guangzhou", "ap-hongkong"]),
    fromAddress: z.email().max(254),
    templateId: z.int().positive(),
  })
  .readonly();
function readMailFile(source: EnvSource, issues: EnvIssue[]): MailTencentEnvConfig | undefined {
  const text = readWechatFile(source, "MAIL_TENCENT", issues, true);
  if (text === undefined) return undefined;
  try {
    const parsed = MailTencentEnvSchema.safeParse(JSON.parse(text) as unknown);
    if (parsed.success) return parsed.data;
  } catch {
    /* 不回显配置值、路径或JSON错误。 */
  }
  issues.push({ key: "MAIL_TENCENT_FILE", reason: "须为完整合法的邮件JSON配置" });
  return undefined;
}
const LlmEndpointEnvSchema = z
  .object({
    vendor: z.enum(["ark", "bailian", "deepseek"]),
    model: z.string().refine((value) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)),
    apiKey: z.string().refine((value) => /^[\x21-\x7e]{1,512}$/.test(value)),
    workspaceId: z.string().optional(),
  })
  .strict()
  .superRefine((endpoint, context) => {
    const valid =
      endpoint.vendor === "bailian"
        ? endpoint.workspaceId !== undefined &&
          /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(endpoint.workspaceId)
        : endpoint.workspaceId === undefined;
    if (!valid) context.addIssue({ code: "custom", message: "工作区配置不合法" });
  })
  .readonly();
const LlmRouteEnvSchema = z
  .object({ primary: LlmEndpointEnvSchema, backup: LlmEndpointEnvSchema })
  .strict()
  .readonly();
const LlmDomesticEnvSchema = z
  .object({ text: LlmRouteEnvSchema, vision: LlmRouteEnvSchema })
  .strict()
  .readonly();

function readModelFile<T>(
  source: EnvSource,
  key: "ASR_TENCENT" | "OCR_TENCENT" | "LLM_DOMESTIC",
  issues: EnvIssue[],
  schema: z.ZodType<T>,
): T | undefined {
  const text = readWechatFile(source, key, issues);
  if (text === undefined) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(text) as unknown);
    if (parsed.success) return parsed.data;
  } catch {
    // 不透传 JSON/Zod 异常、字段值或路径。
  }
  issues.push({ key: `${key}_FILE`, reason: "须为完整合法的模型JSON配置" });
  return undefined;
}

// 与已接受 ASR sender 的 origin 谓词等价；本文件保持无相对导入。
function asrCallbackOrigin(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 266 ||
    [...value].some((char) => {
      const code = char.charCodeAt(0);
      return code <= 32 || code >= 127;
    })
  )
    return undefined;
  const matched = /^https:\/\/([a-z0-9.-]+)(?::443)?\/?$/.exec(value);
  if (!matched) return undefined;
  const host = matched[1]!,
    labels = host.split(".");
  if (
    host.length > 253 ||
    labels.length < 2 ||
    !/[a-z]/.test(labels.at(-1)!) ||
    ["local", "localhost", "internal", "onion", "invalid", "test"].includes(labels.at(-1)!) ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return undefined;
  try {
    const parsed = new URL(value);
    return parsed.hostname === host ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/** 独立有界读取；fatal UTF8 且保留 BOM，不裁剪、归一化或解释密钥编码。 */
function readAsrCallbackKey(path: string, issues: EnvIssue[]): string | undefined {
  const key = "ASR_CALLBACK_KEY_FILE";
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256) throw new Error();
    const bytes = Buffer.alloc(257);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset < 32 || offset > 256) throw new Error();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, offset),
    );
  } catch {
    issues.push({ key, reason: "须为32至256字节的原始UTF8普通文件" });
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        issues.push({ key, reason: "配置文件关闭失败" });
      }
    }
  }
  return undefined;
}

function readAsrCallback(
  source: EnvSource,
  asr: AsrTencentEnvConfig | undefined,
  issues: EnvIssue[],
): Env["ASR_CALLBACK"] {
  if (source.ASR_CALLBACK_KEY !== undefined)
    issues.push({ key: "ASR_CALLBACK_KEY", reason: "只认独立ASR_CALLBACK_KEY_FILE，不接受明文" });
  const rawOrigin =
    read(source, "ASR_CALLBACK_ORIGIN") === undefined ? undefined : source.ASR_CALLBACK_ORIGIN;
  const path = read(source, "ASR_CALLBACK_KEY_FILE");
  if (rawOrigin === undefined && path === undefined) return undefined;
  const origin = asrCallbackOrigin(rawOrigin);
  if (!origin)
    issues.push({
      key: "ASR_CALLBACK_ORIGIN",
      reason: "须为固定HTTPS DNS根origin，与独立KEY_FILE成对",
    });
  if (!path)
    issues.push({ key: "ASR_CALLBACK_KEY_FILE", reason: "须与ASR_CALLBACK_ORIGIN成对配置" });
  if (!asr) issues.push({ key: "ASR_TENCENT_FILE", reason: "ASR回调须有完整合法的腾讯ASR配置" });
  const key = path === undefined ? undefined : readAsrCallbackKey(path, issues);
  return origin && key && asr ? Object.freeze({ origin, key }) : undefined;
}

function readCi(source: EnvSource, issues: EnvIssue[]): Env["CI"] {
  const callbackKey = readWechatFile(source, "CI_CALLBACK_KEY", issues);
  const workerText = readWechatFile(source, "CI_WORKER_KEYS", issues);
  const fields = [
    "CI_REGION",
    "CI_BUCKET_SECURE",
    "CI_BUCKET_ASSET",
    "CI_BUCKET_MEDIA",
    "CI_BUCKET_PUB",
  ] as const;
  const values = fields.map((key) => read(source, key));
  const origin = read(source, "CI_CALLBACK_ORIGIN");
  if (!callbackKey && !workerText && !origin && !values.some(Boolean)) return undefined;
  if (
    !callbackKey ||
    Buffer.byteLength(callbackKey) < 32 ||
    Buffer.byteLength(callbackKey) > 256 ||
    !/^[\x21-\x7e]+$/.test(callbackKey)
  )
    issues.push({ key: "CI_CALLBACK_KEY_FILE", reason: "回调密钥须为32至256字节可见ASCII" });
  try {
    const parsed = new URL(origin ?? "");
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/"
    )
      throw new Error();
  } catch {
    issues.push({
      key: "CI_CALLBACK_ORIGIN",
      reason: "须为固定HTTPS根origin，无用户信息/查询/片段",
    });
  }
  let worker: NonNullable<Env["CI"]>["worker"];
  if (workerText || values.some(Boolean)) {
    for (const [index, key] of fields.entries())
      if (!values[index]) issues.push({ key, reason: "CI worker地域与四桶须成组配置" });
    if (!workerText)
      issues.push({ key: "CI_WORKER_KEYS_FILE", reason: "CI worker须有独立角色FILE" });
    const region = values[0];
    if (region && !/^[a-z]+(?:-[a-z0-9]+){1,4}$/.test(region))
      issues.push({ key: "CI_REGION", reason: "不是合法地域" });
    for (const [index, value] of values.entries())
      if (index > 0 && value && !/^[a-z0-9][a-z0-9-]{1,50}-[0-9]{5,20}$/.test(value))
        issues.push({ key: fields[index]!, reason: "须为物理桶名" });
    if (
      new Set(
        values
          .slice(1)
          .filter(Boolean)
          .map((value) => value!.split("-").at(-1)),
      ).size > 1
    )
      issues.push({ key: "CI_BUCKET_SECURE", reason: "四桶须同一账号" });
    try {
      const role: unknown = JSON.parse(workerText ?? "");
      if (
        !isRecord(role) ||
        Object.keys(role).some((key) => key !== "secretId" && key !== "secretKey") ||
        typeof role.secretId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(role.secretId) ||
        typeof role.secretKey !== "string" ||
        !/^[\x21-\x7e]{1,256}$/.test(role.secretKey)
      )
        throw new Error();
      if (region && values[1] && values[2] && values[3] && values[4])
        worker = {
          region,
          buckets: { secure: values[1], asset: values[2], media: values[3], pub: values[4] },
          secretId: role.secretId,
          secretKey: role.secretKey,
        };
    } catch {
      issues.push({
        key: "CI_WORKER_KEYS_FILE",
        reason: "须为合法secretId/secretKey JSON普通文件",
      });
    }
  }
  if (!callbackKey || !origin) return undefined;
  return { callback: { key: callbackKey, origin }, ...(worker ? { worker } : {}) };
}

function readCos(source: EnvSource, issues: EnvIssue[]): Env["COS"] {
  const fields = [
    "COS_REGION",
    "COS_BUCKET_SECURE",
    "COS_BUCKET_ASSET",
    "COS_BUCKET_MEDIA",
    "COS_BUCKET_PUB",
  ] as const;
  const roles: {
    signer?: { secretId: string; secretKey: string };
    stsIssuer?: { secretId: string; secretKey: string };
    worker?: { secretId: string; secretKey: string };
  } = {};
  for (const [key, role] of [
    ["COS_SIGNER_KEYS", "signer"],
    ["COS_STS_ISSUER_KEYS", "stsIssuer"],
    ["COS_WORKER_KEYS", "worker"],
  ] as const) {
    const content = readWechatFile(source, key, issues);
    if (content === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(content);
      if (
        !isRecord(parsed) ||
        Object.keys(parsed).some((field) => field !== "secretId" && field !== "secretKey") ||
        typeof parsed.secretId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.secretId) ||
        typeof parsed.secretKey !== "string" ||
        !/^[\x21-\x7e]{1,256}$/.test(parsed.secretKey)
      )
        throw new Error("shape");
      roles[role] = { secretId: parsed.secretId, secretKey: parsed.secretKey };
    } catch {
      issues.push({ key: `${key}_FILE`, reason: "须为合法的 secretId/secretKey JSON 普通文件" });
    }
  }
  const values = fields.map((key) => read(source, key));
  if (!values.some((value) => value !== undefined) && !Object.keys(roles).length) return undefined;
  for (const [index, key] of fields.entries())
    if (values[index] === undefined) issues.push({ key, reason: "COS 地域和四桶须完整配置" });
  const region = values[0];
  if (region && !/^[a-z]+(?:-[a-z0-9]+){1,4}$/.test(region))
    issues.push({ key: "COS_REGION", reason: "不是合法的 COS 地域标识" });
  const buckets = { secure: values[1], asset: values[2], media: values[3], pub: values[4] };
  for (const [index, value] of values.entries())
    if (index > 0 && value && !/^[a-z0-9][a-z0-9-]{1,50}-[0-9]{5,20}$/.test(value))
      issues.push({ key: fields[index]!, reason: "须为带账号后缀的物理桶名" });
  if (
    new Set(
      values
        .slice(1)
        .filter((value) => value !== undefined)
        .map((value) => value!.split("-").at(-1)),
    ).size > 1
  )
    issues.push({ key: "COS_BUCKET_SECURE", reason: "四桶须属于同一账号" });
  if (!roles.worker && (!roles.signer || !roles.stsIssuer))
    issues.push({
      key: "COS_SIGNER_KEYS_FILE",
      reason: "API 须完整配置 signer 与 STS issuer；worker 须有独立角色",
    });
  if (
    Object.keys(roles).length &&
    (read(source, "MINIO_ENDPOINT") || read(source, "MINIO_PUBLIC_ENDPOINT"))
  )
    issues.push({ key: "COS_REGION", reason: "COS 与 MinIO 不能同时选择" });
  if (!region || !buckets.secure || !buckets.asset || !buckets.media || !buckets.pub)
    return undefined;
  return {
    region,
    buckets: {
      secure: buckets.secure,
      asset: buckets.asset,
      media: buckets.media,
      pub: buckets.pub,
    },
    ...roles,
  };
}

function readWechat(source: EnvSource, issues: EnvIssue[]): WechatConfig | undefined {
  const appid = read(source, "WECHAT_APPID");
  const secret = readWechatFile(source, "WECHAT_SECRET", issues);
  const messageToken = readWechatFile(source, "WECHAT_MESSAGE_TOKEN", issues);
  const messageEncodingAESKey = readWechatFile(source, "WECHAT_MESSAGE_AES_KEY", issues);
  const ascii = (value: string | undefined, maximum: number) =>
    value === undefined || (value.length <= maximum && /^[\x21-\x7e]+$/.test(value));
  if (appid !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(appid))
    issues.push({ key: "WECHAT_APPID", reason: "须为1至128个字母、数字、下划线或短横线" });
  if (!ascii(secret, 256))
    issues.push({ key: "WECHAT_SECRET_FILE", reason: "须为1至256个可见ASCII字符" });
  if (!ascii(messageToken, 128))
    issues.push({ key: "WECHAT_MESSAGE_TOKEN_FILE", reason: "须为1至128个可见ASCII字符" });
  if (
    messageEncodingAESKey !== undefined &&
    (!/^[A-Za-z0-9+/]{43}$/.test(messageEncodingAESKey) ||
      Buffer.from(messageEncodingAESKey + "=", "base64").length !== 32 ||
      Buffer.from(messageEncodingAESKey + "=", "base64").toString("base64") !==
        messageEncodingAESKey + "=")
  )
    issues.push({
      key: "WECHAT_MESSAGE_AES_KEY_FILE",
      reason: "须为规范43字符base64编码的32字节密钥",
    });
  if (
    appid === undefined ||
    secret === undefined ||
    messageToken === undefined ||
    messageEncodingAESKey === undefined
  )
    return undefined;
  return Object.freeze({ appid, secret, messageToken, messageEncodingAESKey });
}

const EnvSchema = z.object({
  APP_ENV: z.enum(APP_ENVS, { error: `必填，只能是 ${APP_ENVS.join("、")} 之一` }),
  LOG_LEVEL: z.enum(LOG_LEVELS, { error: `只能是 ${LOG_LEVELS.join("、")} 之一` }).default("info"),
  DATABASE_URL: z
    .string()
    .refine((value) => hasProtocol(value, CONNECTION_KEYS.DATABASE_URL), {
      error: "不是合法的 postgresql:// 连接串",
    })
    .optional(),
  REDIS_URL: z
    .string()
    .refine((value) => hasProtocol(value, CONNECTION_KEYS.REDIS_URL), {
      error: "不是合法的 redis:// 连接串",
    })
    .optional(),
});

function readAdminIpAllowlist(
  source: EnvSource,
  issues: EnvIssue[],
): readonly string[] | undefined {
  const raw = read(source, "ADMIN_IP_ALLOWLIST");
  if (raw === undefined) return undefined;
  const entries = raw.split(",").map((entry) => entry.trim());
  try {
    const parsed = new BlockList();
    for (const entry of entries) {
      const [address = "", prefix, extra] = entry.split("/");
      const version = isIP(address),
        max = version === 4 ? 32 : 128;
      const bits = prefix === undefined ? max : Number(prefix);
      if (
        version === 0 ||
        extra !== undefined ||
        (prefix !== undefined && !/^\d+$/.test(prefix)) ||
        !Number.isInteger(bits) ||
        bits < 0 ||
        bits > max
      )
        throw new Error();
      parsed.addSubnet(address, bits, version === 4 ? "ipv4" : "ipv6");
    }
  } catch {
    issues.push({ key: "ADMIN_IP_ALLOWLIST", reason: "必须是逗号分隔的合法 IP 或 CIDR 列表" });
    return undefined;
  }
  return Object.freeze(entries);
}

function readCertDomains(source: EnvSource, issues: EnvIssue[]): readonly string[] | undefined {
  const raw = read(source, "CERT_DOMAINS");
  if (raw === undefined) return undefined;
  const domains = raw.split(",").map((domain) => domain.trim().toLowerCase());
  if (
    raw.length > 4096 ||
    domains.length > 16 ||
    domains.some(
      (domain) =>
        domain.length > 200 ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain),
    )
  ) {
    issues.push({ key: "CERT_DOMAINS", reason: "须为至多16个逗号分隔的DNS域名，每个至多200字符" });
    return undefined;
  }
  return Object.freeze([...new Set(domains)]);
}

function readPortalPublicOrigin(source: EnvSource, issues: EnvIssue[]): string | undefined {
  const value = read(source, "PORTAL_PUBLIC_ORIGIN");
  if (value === undefined) return undefined;
  // 先校验原始形状，避免 URL 将空查询、点路径、反斜线或控制字符归一化后接受。
  const matched = /^https:\/\/([a-z0-9.-]+)(?::[0-9]{1,5})?\/?$/i.exec(value);
  const host = matched?.[1]?.toLowerCase();
  const labels = host?.split(".") ?? [];
  if (
    host &&
    host.length <= 253 &&
    labels.length >= 2 &&
    /[a-z]/.test(labels.at(-1)!) &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    try {
      const parsed = new URL(value);
      if (parsed.hostname === host) return parsed.origin;
    } catch {
      // 只返回固定键名与原因，不回显配置值。
    }
  }
  issues.push({
    key: "PORTAL_PUBLIC_ORIGIN",
    reason: "须为HTTPS DNS根地址，不含账号密码、路径、查询或片段",
  });
  return undefined;
}

function readStagingPay(
  source: EnvSource,
  appEnv: string | undefined,
  issues: EnvIssue[],
): Env["STAGING_PAY"] {
  const raw = read(source, "STAGING_PAY_ENTITY_IDS");
  if (raw === undefined) return undefined;
  if (appEnv !== "stg") {
    issues.push({ key: "STAGING_PAY_ENTITY_IDS", reason: "仅stg环境允许配置非空主体名单" });
    return undefined;
  }
  const entityIds = raw.split(",").map((id) => id.trim());
  // 与契约IdSchema的版本/变体及小写口径一致；本配置入口保持可独立由Node加载。
  const idSchema = z.uuidv7();
  if (
    source["STAGING_PAY_ENTITY_IDS"]!.length > 4096 ||
    entityIds.length > 100 ||
    entityIds.some((id) => id !== id.toLowerCase() || !idSchema.safeParse(id).success) ||
    new Set(entityIds).size !== entityIds.length
  ) {
    issues.push({
      key: "STAGING_PAY_ENTITY_IDS",
      reason: "须为至多100个不重复的小写UUIDv7，逗号分隔、无空项且非空输入总长不超过4096字符",
    });
    return undefined;
  }
  return Object.freeze({ entityIds: Object.freeze(entityIds) });
}

/**
 * 读取并校验环境变量。任何一项不合格即抛 EnvError，一次列出全部问题。
 * @param source 缺省读 process.env；测试里传对象
 * @param options.groups 成组规则，缺省用 ENV_GROUPS
 */
function validAgeRecipient(value: string): boolean {
  const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  if (!/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/u.test(value)) return false;
  const values = [...value.slice(4)].map((letter) => alphabet.indexOf(letter));
  const hrp = [..."age"].map((letter) => letter.charCodeAt(0));
  let checksum = 1;
  for (const digit of [
    ...hrp.map((letter) => letter >> 5),
    0,
    ...hrp.map((letter) => letter & 31),
    ...values,
  ]) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ digit;
    for (const [index, generator] of [
      0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
    ].entries())
      if ((top >>> index) & 1) checksum ^= generator;
  }
  return checksum === 1 && (values[51]! & 15) === 0;
}
function validBackupConnection(value: string): boolean {
  try {
    if (value.length > 2048 || /[\p{Cc}\\]/u.test(value)) return false;
    const url = new URL(value);
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      !username ||
      !database ||
      [username, password, database].some((field) => /[\p{Cc}]/u.test(field)) ||
      url.hash
    )
      return false;
    const seen = new Set<string>();
    for (const [key, field] of url.searchParams) {
      if (seen.has(key)) return false;
      seen.add(key);
      if (key === "sslmode") {
        if (!["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(field))
          return false;
      } else if (key === "connect_timeout") {
        if (!/^[0-9]+$/u.test(field) || Number(field) < 1 || Number(field) > 30) return false;
      } else return false;
    }
    return true;
  } catch {
    return false;
  }
}
const BackupEnvSchema = z.strictObject({
  databaseUrl: z.string().refine(validBackupConnection),
  recipient: z.string().refine(validAgeRecipient),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(2 * 1024 * 1024 * 1024)
    .default(2 * 1024 * 1024 * 1024),
  target: z.strictObject({
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u),
    prefix: z
      .string()
      .max(256)
      .regex(/^(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/)?$/u)
      .refine((value) => !value.startsWith("incoming/")),
    region: z
      .string()
      .regex(/^[a-z]+(?:-[a-z0-9]+){1,4}$/u)
      .optional(),
    key: z
      .strictObject({
        secretId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
        secretKey: z.string().regex(/^[\x21-\x7e]{1,256}$/u),
      })
      .optional(),
  }),
});
function readBackup(
  source: EnvSource,
  appEnv: string | undefined,
  cos: Env["COS"],
  issues: EnvIssue[],
): BackupEnvConfig | undefined {
  const text = readWechatFile(source, "BACKUP", issues, true);
  if (text === undefined) return undefined;
  try {
    const parsed = BackupEnvSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error();
    const backup = parsed.data;
    if (
      cos &&
      ([cos.buckets.asset, cos.buckets.media, cos.buckets.pub].includes(backup.target.bucket) ||
        (backup.target.bucket === cos.buckets.secure && backup.target.prefix === ""))
    )
      throw new Error();
    if (appEnv === "prod") {
      if (
        !backup.target.key ||
        (cos && Object.values(cos.buckets).includes(backup.target.bucket)) ||
        [cos?.worker, cos?.signer, cos?.stsIssuer].some(
          (role) => role?.secretId === backup.target.key?.secretId,
        )
      )
        throw new Error();
    }
    return backup;
  } catch {
    issues.push({ key: "BACKUP_FILE", reason: "须为完整合法的备份JSON；生产须专用目标与独立密钥" });
    return undefined;
  }
}

const AlertsEnvSchema = z.strictObject({
  robotKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,256}$/u)
    .optional(),
  oncallPhones: z
    .array(z.string().regex(/^1[3-9][0-9]{9}$/u))
    .max(16)
    .refine((items) => new Set(items).size === items.length)
    .default([]),
  p2Immediate: z
    .array(
      z
        .string()
        .max(120)
        .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u),
    )
    .max(64)
    .refine((items) => new Set(items).size === items.length)
    .optional(),
});
function readAlerts(source: EnvSource, issues: EnvIssue[]): AlertsEnvConfig | undefined {
  const text = readWechatFile(source, "ALERTS", issues, true);
  if (text === undefined) return undefined;
  try {
    const parsed = AlertsEnvSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // 仅报告固定键与原因，配置值、路径与电话号码均不进入诊断。
  }
  issues.push({
    key: "ALERTS_FILE",
    reason: "须为合法的告警JSON，机器人key/值班人/即时规则列表格式错误",
  });
  return undefined;
}

function readServerErrors(source: EnvSource, issues: EnvIssue[]): ServerErrorsConfig | undefined {
  const text = readWechatFile(source, "SERVER_ERRORS", issues, true);
  if (text === undefined) return undefined;
  try {
    const project = z.strictObject({ dsn: z.string().max(2_048).refine(validErrorDsn) });
    const parsed = z
      .strictObject({ api: project.optional(), worker: project.optional() })
      .refine((one) => one.api !== undefined || one.worker !== undefined)
      .safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    /* 只保固定键/原因，不保路径、DSN或原始JSON错误。 */
  }
  issues.push({ key: "SERVER_ERRORS_FILE", reason: "须为api/worker独立合法HTTPS DSN的严格JSON" });
  return undefined;
}

function readEsignSsm(source: EnvSource, issues: EnvIssue[]): EsignSsmEnvConfig | undefined {
  const keys = [
    "ESIGN_SSM_REGION",
    "ESIGN_SSM_SECRET_NAME",
    "ESIGN_SSM_VERSION_ID",
    "ESIGN_SSM_STS_CREDENTIALS_FILE",
  ] as const;
  const values = keys.map((key) => read(source, key));
  if (values.every((value) => value === undefined)) return undefined;
  const [region, secretName, versionId, stsCredentialsFile] = values;
  const valid = [
    region !== undefined && /^ap-[a-z]+(?:-[a-z]+)*$/.test(region),
    secretName !== undefined && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(secretName),
    versionId !== undefined &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(versionId) &&
      !/^ssm_/i.test(versionId),
    stsCredentialsFile !== undefined && validEsignPath(stsCredentialsFile),
  ];
  valid.forEach((value, index) => {
    if (!value)
      issues.push({ key: keys[index]!, reason: "须完整配置固定SSM版本与worker临时身份文件描述" });
  });
  return valid.every(Boolean)
    ? Object.freeze({
        region: region!,
        secretName: secretName!,
        versionId: versionId!,
        stsCredentialsFile: stsCredentialsFile!,
      })
    : undefined;
}
function validEsignPath(value: string): boolean {
  return (
    value.length <= 4096 &&
    isAbsolute(value) &&
    normalize(value) === value &&
    !/[\p{Cc}]/u.test(value)
  );
}
function readPdfFontDir(source: EnvSource, issues: EnvIssue[]): string | undefined {
  const value = read(source, "LYX_PDF_FONT_DIR");
  if (value !== undefined && !validEsignPath(value)) {
    issues.push({ key: "LYX_PDF_FONT_DIR", reason: "须为绝对规范字体目录" });
    return undefined;
  }
  return value;
}

export function loadEnv(
  source: EnvSource = process.env,
  options: { groups?: readonly EnvGroup[] } = {},
): Env {
  const issues: EnvIssue[] = [];
  const appEnv = read(source, "APP_ENV");
  const adminIpAllowlist = readAdminIpAllowlist(source, issues);
  const certDomains = readCertDomains(source, issues);
  const portalPublicOrigin = readPortalPublicOrigin(source, issues);
  const esignSsm = readEsignSsm(source, issues);
  const pdfFontDir = readPdfFontDir(source, issues);
  const stagingPay = readStagingPay(source, appEnv, issues);
  const alerts = readAlerts(source, issues);
  const serverErrors = readServerErrors(source, issues);

  const parsed = EnvSchema.safeParse({
    APP_ENV: appEnv,
    LOG_LEVEL: read(source, "LOG_LEVEL"),
    DATABASE_URL: readConnection(source, "DATABASE_URL", appEnv, issues),
    REDIS_URL: readConnection(source, "REDIS_URL", appEnv, issues),
  });
  const dataKeys = readKeyFile(source, "DATA_KEYS", issues, parseDataKeys);
  const bidxKeys = readKeyFile(source, "BIDX_KEYS", issues, parseBidxKeys);
  const authKeys = readKeyFile(source, "AUTH_KEYS", issues, parseAuthKeys);
  const secretId = readSmsSecret(source, "SMS_SECRET_ID", issues);
  const secretKey = readSmsSecret(source, "SMS_SECRET_KEY", issues);
  const sdkAppId = read(source, "SMS_SDK_APP_ID");
  const region = read(source, "SMS_REGION");
  if (sdkAppId !== undefined && !/^\d{1,20}$/.test(sdkAppId))
    issues.push({ key: "SMS_SDK_APP_ID", reason: "须为数字应用ID" });
  if (region !== undefined && !/^ap-[a-z]+(?:-[a-z]+)*$/.test(region))
    issues.push({ key: "SMS_REGION", reason: "须为腾讯云地域编码" });
  const wechat = readWechat(source, issues);
  const wechatPay = readWechatPay(source, issues);
  const minio = readMinio(source, appEnv, issues);
  const cos = readCos(source, issues);
  const backup = readBackup(source, appEnv, cos, issues);
  const ci = readCi(source, issues);
  const asrTencent = readModelFile(source, "ASR_TENCENT", issues, AsrTencentEnvSchema);
  const ocrTencent = readModelFile(source, "OCR_TENCENT", issues, OcrTencentEnvSchema);
  const mailTencent = readMailFile(source, issues);
  const llmDomestic = readModelFile(source, "LLM_DOMESTIC", issues, LlmDomesticEnvSchema);
  const asrCallback = readAsrCallback(source, asrTencent, issues);
  const mediaProduction = readKeyFile(source, "MEDIA_PRODUCTION", issues, parseMediaProduction);
  if (
    mediaProduction &&
    "mode" in mediaProduction &&
    ["probe_only", "local_sample_watermark"].includes(mediaProduction.mode) &&
    appEnv !== "local" &&
    appEnv !== "test"
  ) {
    issues.push({
      key: "MEDIA_PRODUCTION_FILE",
      reason: `${mediaProduction.mode} 仅允许 local/test 环境`,
    });
  }
  const clientErrorProjects = readKeyFile(
    source,
    "CLIENT_ERROR_PROJECTS",
    issues,
    parseClientErrorProjects,
  );
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ key: issue.path.join("."), reason: issue.message });
    }
  }
  const groups = options.groups ?? ENV_GROUPS;
  issues.push(
    ...groupIssues(source, groups.includes(WECHAT_GROUP) ? groups : [...groups, WECHAT_GROUP]),
  );

  if (issues.length > 0 || !parsed.success) {
    const order = (issue: EnvIssue) => {
      const index = ENV_KEYS.indexOf(issue.key);
      return index === -1 ? ENV_KEYS.length : index;
    };
    throw new EnvError([...issues].sort((a, b) => order(a) - order(b)));
  }

  const { APP_ENV, LOG_LEVEL, DATABASE_URL, REDIS_URL } = parsed.data;
  // 连接串缺失时上面已经报过并抛出；到这里一定有值
  if (DATABASE_URL === undefined || REDIS_URL === undefined) {
    throw new EnvError([{ key: "DATABASE_URL", reason: "必填，未配置" }]);
  }
  return Object.freeze({
    APP_ENV,
    LOG_LEVEL,
    DATABASE_URL,
    REDIS_URL,
    ...(adminIpAllowlist ? { ADMIN_IP_ALLOWLIST: adminIpAllowlist } : {}),
    ...(certDomains ? { CERT_DOMAINS: certDomains } : {}),
    ...(portalPublicOrigin ? { PORTAL_PUBLIC_ORIGIN: portalPublicOrigin } : {}),
    ...(esignSsm ? { ESIGN_SSM: esignSsm } : {}),
    ...(pdfFontDir ? { LYX_PDF_FONT_DIR: pdfFontDir } : {}),
    ...(stagingPay ? { STAGING_PAY: stagingPay } : {}),
    ...(alerts ? { ALERTS: alerts } : {}),
    ...(serverErrors ? { SERVER_ERRORS: serverErrors } : {}),
    ...(minio ? { MINIO: minio } : {}),
    ...(cos ? { COS: cos } : {}),
    ...(backup ? { BACKUP: backup } : {}),
    ...(ci ? { CI: ci } : {}),
    ...(mediaProduction ? { MEDIA_PRODUCTION: mediaProduction } : {}),
    ...(asrTencent ? { ASR_TENCENT: asrTencent } : {}),
    ...(ocrTencent ? { OCR_TENCENT: ocrTencent } : {}),
    ...(mailTencent ? { MAIL_TENCENT: mailTencent } : {}),
    ...(llmDomestic ? { LLM_DOMESTIC: llmDomestic } : {}),
    ...(asrCallback ? { ASR_CALLBACK: asrCallback } : {}),
    ...(dataKeys && bidxKeys ? { DATA_KEYS: dataKeys, BIDX_KEYS: bidxKeys } : {}),
    ...(authKeys ? { AUTH_KEYS: authKeys } : {}),
    ...(secretId && secretKey && sdkAppId && region
      ? { SMS: { secretId, secretKey, sdkAppId, region } }
      : {}),
    ...(wechat ? { WECHAT: wechat } : {}),
    ...(wechatPay ? { WECHAT_PAY: wechatPay } : {}),
    ...(clientErrorProjects ? { CLIENT_ERROR_PROJECTS: clientErrorProjects } : {}),
  });
}
