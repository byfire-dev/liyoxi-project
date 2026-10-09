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

import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";

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
  "WECHAT_APPID",
  "WECHAT_SECRET_FILE",
  "WECHAT_MESSAGE_TOKEN_FILE",
  "WECHAT_MESSAGE_AES_KEY_FILE",
  "CLIENT_ERROR_PROJECTS_FILE",
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

export interface Env {
  readonly MEDIA_PRODUCTION?: {
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
  /** 整组未配置时没有此项；敏感字段只能从 FILE 读取。 */
  readonly WECHAT?: WechatConfig;
  readonly CLIENT_ERROR_PROJECTS?: ClientErrorProjectsConfig;
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
  key: "DATA_KEYS" | "BIDX_KEYS" | "AUTH_KEYS" | "CLIENT_ERROR_PROJECTS" | "MEDIA_PRODUCTION",
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
  const schema = z.strictObject({
    workDir: z.string().regex(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/),
    socketPath: z.string().min(1).max(512),
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
  const parsed = schema.safeParse(json);
  if (
    !parsed.success ||
    !parsed.data.socketPath.startsWith(`${parsed.data.workDir}/.sock/`) ||
    !/^[A-Za-z0-9._-]+$/.test(parsed.data.socketPath.slice(parsed.data.workDir.length + 7))
  )
    return "制作配置须为完整工作目录/同目录套接字/七字段主体口径/六模板映射；不得带任意路径";
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
function readWechatFile(source: EnvSource, key: string, issues: EnvIssue[]): string | undefined {
  if (read(source, key) !== undefined)
    issues.push({ key, reason: `敏感项只认 ${key}_FILE，任何环境都不接受明文` });
  const fileKey = `${key}_FILE`;
  const path = read(source, fileKey);
  if (path === undefined) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
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
    const value = bytes.subarray(0, offset).toString("utf8").trim();
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

/**
 * 读取并校验环境变量。任何一项不合格即抛 EnvError，一次列出全部问题。
 * @param source 缺省读 process.env；测试里传对象
 * @param options.groups 成组规则，缺省用 ENV_GROUPS
 */
export function loadEnv(
  source: EnvSource = process.env,
  options: { groups?: readonly EnvGroup[] } = {},
): Env {
  const issues: EnvIssue[] = [];
  const appEnv = read(source, "APP_ENV");

  const parsed = EnvSchema.safeParse({
    APP_ENV: appEnv,
    LOG_LEVEL: read(source, "LOG_LEVEL"),
    DATABASE_URL: readConnection(source, "DATABASE_URL", appEnv, issues),
    REDIS_URL: readConnection(source, "REDIS_URL", appEnv, issues),
  });
  const dataKeys = readKeyFile(source, "DATA_KEYS", issues, parseDataKeys);
  const bidxKeys = readKeyFile(source, "BIDX_KEYS", issues, parseBidxKeys);
  const authKeys = readKeyFile(source, "AUTH_KEYS", issues, parseAuthKeys);
  const wechat = readWechat(source, issues);
  const minio = readMinio(source, appEnv, issues);
  const cos = readCos(source, issues);
  const ci = readCi(source, issues);
  const mediaProduction = readKeyFile(source, "MEDIA_PRODUCTION", issues, parseMediaProduction);
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
    ...(minio ? { MINIO: minio } : {}),
    ...(cos ? { COS: cos } : {}),
    ...(ci ? { CI: ci } : {}),
    ...(mediaProduction ? { MEDIA_PRODUCTION: mediaProduction } : {}),
    ...(dataKeys && bidxKeys ? { DATA_KEYS: dataKeys, BIDX_KEYS: bidxKeys } : {}),
    ...(authKeys ? { AUTH_KEYS: authKeys } : {}),
    ...(wechat ? { WECHAT: wechat } : {}),
    ...(clientErrorProjects ? { CLIENT_ERROR_PROJECTS: clientErrorProjects } : {}),
  });
}
