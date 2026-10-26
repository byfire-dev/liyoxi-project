import type { VerifiedTradeBillResult } from "./wechat-pay/bill-evidence.js";
export type { VerifiedTradeBill, VerifiedTradeBillResult } from "./wechat-pay/bill-evidence.js";
// Provider 接口：12 个外部能力（01 第 9 节；ADR-039）。领域模块只引本文件（D7 第 2.2 节 D8）。
//
// 写法上的约定（W0-19 任务书 第 11 节第 1、3、5 项）：
//   1. 方法按 01 第 9 节“用途”列一项一个，入参出参取能确定的最小集。后续使用方只增方法或可选字段；
//      改已有签名要在 PR 描述里单列。
//   2. 每个方法都返回 Promise<ProviderResult<T>>。没办成不抛错，返回 { ok: false, reason }：
//      调用方看 reason 分支来降级，不靠捕获异常（01 第 2.2 节 P5）。只有程序错误才抛，比如在事务里外呼。
//   3. 每个接口带 status（生效状态）与 configured（这项能力现在能不能用）。
//   4. 金额一律整数分，字段名以 Fen 结尾。
//   5. 加方法时三处一起改，少一处即编译失败：接口、PROVIDER_METHODS、未配置实现与替身。
// 本文件只从无反向依赖的 mediatool 结构文件引类型与纯 DTO 校验，不依赖客户端或工作区实现。

import type {
  DocTextResult,
  MediaToolDemuxer,
  MediaToolHealth,
  ProbeReport,
} from "./mediatool/schema.js";
import type { BankReceiptFields } from "./ocr/receipt.js";
export { BankReceiptFieldsSchema } from "./ocr/receipt.js";
export type { BankReceiptFields } from "./ocr/receipt.js";

import type { LlmDigest, LlmDigestInput } from "./llm/digest.js";
import type { LlmVision, LlmVisionInput } from "./llm/vision.js";
export { isLlmDigestInput, LlmDigestSchema } from "./llm/digest.js";
export type { LlmDigest, LlmDigestInput, LlmDigestVocabulary } from "./llm/digest.js";
export { isLlmVisionInput, LlmVisionSchema } from "./llm/vision.js";
export type { LlmVision, LlmVisionInput } from "./llm/vision.js";
export { isAsrQueryTaskId, isAsrSubmitUrl } from "./asr/input.js";

// ---------- 通用 ----------

/** Provider 运行在哪个环境。取值与 kernel 的 AppEnv 相同；这里另写一份，免得 providers 与 kernel 互引成环 */
export const PROVIDER_APP_ENVS = ["local", "test", "stg", "prod"] as const;
export type ProviderAppEnv = (typeof PROVIDER_APP_ENVS)[number];

/** 没办成的原因 */
export type ProviderFailureReason =
  /** 这项能力没配置 */
  | "unconfigured"
  /** 当前驱动没有这个方法的能力（如本地 MinIO 不签发临时密钥） */
  | "unsupported"
  /** 外部服务连不上、超时或报 5xx：可以重试 */
  | "unavailable"
  /** 外部服务明确拒绝，或入参不合规：重试也不会成 */
  | "rejected";

export interface ProviderSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ProviderFailure {
  readonly ok: false;
  readonly reason: ProviderFailureReason;
  /** 给日志与排障看的一句话；不含任何配置值 */
  readonly message: string;
}

export type ProviderResult<T> = ProviderSuccess<T> | ProviderFailure;

export function ok<T>(value: T): ProviderSuccess<T> {
  return { ok: true, value };
}

export function failed(reason: ProviderFailureReason, message: string): ProviderFailure {
  return { ok: false, reason, message };
}

/** 只用于通知发送；通用失败原因不足以证明外部是否受理，不据此自动重发。 */
export const NOTIFICATION_FAILURE_CODES = [
  "no_quota",
  "user_refused",
  "invalid_openid",
  "template_invalid",
  "field_mismatch",
  "rate_limited",
  "provider_rejected",
  "unconfigured",
  "unsupported",
  "aborted",
  "unknown_outcome",
] as const;
export interface NotificationFailureDetail {
  readonly acceptance: "not_accepted" | "unknown";
  readonly code: (typeof NOTIFICATION_FAILURE_CODES)[number];
}
export interface NotificationProviderFailure extends ProviderFailure {
  /** 旧实现可不带；缺省表示受理情况未知，不是可重试证明。 */
  readonly notification?: NotificationFailureDetail;
}
export interface NotificationProviderSuccess<T> extends ProviderSuccess<T> {
  /** 服务商返回的标识，不代表终端到达。≤64 的 ASCII 标识；本地替身不伪造真实标识。 */
  readonly providerMsgId?: string;
}
export type NotificationProviderResult<T> =
  NotificationProviderSuccess<T> | NotificationProviderFailure;

/** 入参强转也不能引入任意分类；message 沿旧契约，不承载原始 Provider 响应/敏感正文。 */
export function notificationFailed(
  reason: ProviderFailureReason,
  message: string,
  detail: NotificationFailureDetail,
): NotificationProviderFailure {
  if (
    detail === null ||
    typeof detail !== "object" ||
    !Object.hasOwn(detail, "acceptance") ||
    !Object.hasOwn(detail, "code") ||
    !["not_accepted", "unknown"].includes(detail.acceptance) ||
    !NOTIFICATION_FAILURE_CODES.includes(detail.code) ||
    Reflect.ownKeys(detail).some((key) => key !== "acceptance" && key !== "code")
  )
    throw new TypeError("通知失败分类不合法");
  return {
    ...failed(reason, message),
    notification: { acceptance: detail.acceptance, code: detail.code },
  };
}

export function notificationOk<T>(
  value: T,
  providerMsgId?: string,
): NotificationProviderSuccess<T> {
  if (
    providerMsgId !== undefined &&
    (typeof providerMsgId !== "string" ||
      providerMsgId.length > 64 ||
      !/^[A-Za-z0-9]/.test(providerMsgId) ||
      /[^A-Za-z0-9._:-]/.test(providerMsgId))
  )
    throw new TypeError("通知服务商标识不合法");
  return { ...ok(value), ...(providerMsgId === undefined ? {} : { providerMsgId }) };
}

/**
 * 生效状态：真实驱动名，或下面三个固定值（任务书 第 11 节第 5 项）。
 *   local         只限 local、test 的落点：本地 MinIO、控制台短信、本地的假微信、媒体的小文件通道
 *   fake          测试替身，只在测试装配里出现
 *   unconfigured  未配置实现
 */
export type ProviderStatus = "local" | "fake" | "unconfigured" | (string & {});

export interface ProviderBase {
  readonly status: ProviderStatus;
  /** 这项能力现在能不能用。业务据此决定入口展不展示（如微信支付），不靠调用失败来试 */
  readonly configured: boolean;
}

/** 启动日志用的最小日志接口；pino 的 logger 可以直接传进来 */
export interface ProviderLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** 内容安全与审核的结论。pending：结果稍后经回调或回查给出 */
export type ContentVerdict = "pass" | "review" | "block" | "pending";

// ---------- wechat：登录、手机号、订阅消息、小程序码、图片与文本内容安全 ----------

export interface WechatSession {
  openid: string;
  unionid?: string;
}

/** 文本内容安全的场景：资料、评论、论坛、社交日志 */
export type WechatTextScene = "profile" | "comment" | "forum" | "social";

export interface ContentCheckOutcome {
  verdict: ContentVerdict;
  /** 外部侧的追踪号；verdict 为 pending 时靠它对上回调 */
  traceId?: string;
}

export interface WechatProvider extends ProviderBase {
  /** 登录：用小程序端 wx.login 给的 code 换 openid */
  code2Session(input: { code: string }): Promise<ProviderResult<WechatSession>>;
  /** 手机号：用手机号组件给的 code 换手机号 */
  getPhoneNumber(input: { code: string }): Promise<
    ProviderResult<{
      phone: string;
      /** 微信真实区号与纯号码；旧替身/调用方可继续只返回phone。 */
      countryCode?: string;
      purePhoneNumber?: string;
    }>
  >;
  /** 订阅消息 */
  sendSubscribeMessage(input: {
    openid: string;
    templateId: string;
    page?: string;
    data: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<NotificationProviderResult<void>>;
  /** 小程序码 */
  createMiniProgramCode(input: {
    scene: string;
    page?: string;
  }): Promise<ProviderResult<{ image: Uint8Array; contentType: string }>>;
  /** 文本内容安全 */
  checkText(input: {
    openid: string;
    scene: WechatTextScene;
    content: string;
  }): Promise<ProviderResult<ContentCheckOutcome>>;
  /** 图片内容安全 */
  checkImage(input: {
    openid: string;
    scene: WechatTextScene;
    mediaUrl: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<ContentCheckOutcome>>;
}

// ---------- wechatPay：预下单、回调验签、查单、关单、退款、账单 ----------

export type WechatPayTradeState =
  "SUCCESS" | "REFUND" | "NOTPAY" | "CLOSED" | "REVOKED" | "USERPAYING" | "PAYERROR";

export type WechatPayRefundStatus = "SUCCESS" | "CLOSED" | "PROCESSING" | "ABNORMAL";

export interface WechatPayTransaction {
  /** 验签后的渠道身份；成功事实必须与装配身份一致。 */
  appid?: string;
  mchid?: string;
  outTradeNo: string;
  tradeState: WechatPayTradeState;
  transactionId?: string;
  amountFen?: number;
  payerOpenid?: string;
  /** 预下单时带的回传数据，原样返回 */
  attach?: string;
  successAt?: Date;
  bankType?: string;
}

export interface WechatPayRefund {
  outRefundNo: string;
  outTradeNo: string;
  refundId: string;
  status: WechatPayRefundStatus;
  refundFen: number;
  successAt?: Date;
  userReceivedAccount?: string;
}

/** 查询专用可信不存在证明；普通HTTP错误码、网络404与超时均不得给出此标记。 */
export type WechatPayRefundQueryResult =
  ProviderSuccess<WechatPayRefund> | (ProviderFailure & { readonly refundNotFound?: true });

/** 验签并解密之后的回调内容。id 是通知编号，同一条通知重复投递时不变 */
export type WechatPayNotification =
  | { kind: "transaction"; id: string; transaction: WechatPayTransaction }
  | { kind: "refund"; id: string; refund: WechatPayRefund };

export interface ResourceCipher {
  algorithm: string;
  ciphertext: string;
  nonce: string;
  associated_data?: string;
  original_type?: string;
}
export type NotificationFailureKind =
  /** 验签不过，或四个请求头不全 */
  | "signature_invalid"
  /** 时间戳与本机相差超过 5 分钟 */
  | "timestamp_skewed"
  /** Wechatpay-Serial 在验签身份表里查不到 */
  | "key_not_found"
  /** 验签通过但解不开：APIv3 密钥或版本不对 */
  | "decrypt_failed"
  /** 报文不全：外层不是 JSON、缺 id、resource 不合规，或解密后缺必需字段、状态与事件类型对不上 */
  | "payload_invalid";

export interface NotificationFailure {
  ok: false;
  kind: NotificationFailureKind;
  /** 签名带探测前缀（WECHATPAY/SIGNTEST/）：照常回失败，不计入验签失败告警 */
  probe: boolean;
  /** 给日志看的一句话；不含请求体、签名与任何密钥 */
  detail: string;
}

/** 长期保留的摘要（h01 第 2.4 节 WechatpayPayload.summary）：任何层级都没有 openid 与 payer */
export interface NotificationSummary {
  serial: string;
  outTradeNo: string;
  outRefundNo?: string;
  transactionId: string;
  refundId?: string;
  state: string;
  amountFen: number;
  /** 成功时间，UTC */
  successAt?: string;
}

export interface NotificationSuccess {
  ok: true;
  /** 通知 id：同一事件重复投递时不变 */
  id: string;
  eventType: string;
  /** 验签所用身份的序列号 */
  serial: string;
  /** 实际解开密文的 APIv3 密钥版本 */
  kid: string;
  /** 报文 resource 原样：收件行存它，重处理时按 kid 重新解密 */
  resourceCipher: ResourceCipher;
  /** 解密后的资源，键名保持微信的写法 */
  resource: Record<string, unknown>;
  /** 登记清单内的四种事件给出归一的内容与摘要；清单外的事件两项都是 null */
  notification: WechatPayNotification | null;
  summary: NotificationSummary | null;
}

export type NotificationResult = NotificationSuccess | NotificationFailure;

export interface MiniProgramPayParams {
  appId: string;
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: "RSA";
  paySign: string;
}

export interface WechatPayProvider extends ProviderBase {
  /** 仅本地密码学；不能发网络请求，重处理事务内可按持久kid解密。 */
  readonly notificationCrypto?: {
    verifyNotification(input: {
      headers: Record<string, string | undefined>;
      rawBody: Uint8Array | string;
    }): NotificationResult;
    reopenResource(resourceCipher: ResourceCipher, kid: string): Record<string, unknown> | null;
  };
  /** 本地生成调起参数，仍经 Provider 事务边界守卫。 */
  signMiniProgramPay(input: { prepayId: string }): Promise<ProviderResult<MiniProgramPayParams>>;
  /** 预下单。幂等于商户单号：同一单号、同样的入参重复调用返回同一个结果 */
  createJsapiOrder(input: {
    outTradeNo: string;
    description: string;
    amountFen: number;
    payerOpenid: string;
    attach?: string;
    expireAt?: Date;
  }): Promise<ProviderResult<{ prepayId: string }>>;
  /** 回调验签并解密。验签不过返回 rejected，调用方须应答失败 */
  verifyAndDecryptNotification(input: {
    headers: Record<string, string>;
    rawBody: string;
  }): Promise<ProviderResult<WechatPayNotification>>;
  /** 查单 */
  queryByOutTradeNo(input: { outTradeNo: string }): Promise<ProviderResult<WechatPayTransaction>>;
  /** 关单。已关返回 closed；已支付返回 paid；该重试的返回 unavailable */
  closeOrder(input: {
    outTradeNo: string;
  }): Promise<ProviderResult<{ outcome: "closed" | "paid" }>>;
  /** 退款。幂等于退款单号 */
  createRefund(input: {
    outTradeNo: string;
    outRefundNo: string;
    refundFen: number;
    totalFen: number;
    reason?: string;
  }): Promise<ProviderResult<WechatPayRefund>>;
  queryRefund(input: { outRefundNo: string }): Promise<WechatPayRefundQueryResult>;
  /** 资金对账专用：来源验签+下载摘要验证后返回原字节；missing不证明无交易。 */
  fetchVerifiedTradeBill(input: {
    billDate: string;
  }): Promise<ProviderResult<VerifiedTradeBillResult>>;
  /** 旧展示口保持行为；资金对账不得使用空文本作为无交易证据。billDate为北京时间。 */
  fetchTradeBill(input: {
    billDate: string;
  }): Promise<ProviderResult<{ billDate: string; text: string }>>;
}

// ---------- storage：签名、临时密钥、复制入库 ----------

/** 四个桶（03 第 5.1 节） */
export const STORAGE_BUCKETS = ["secure", "asset", "media", "pub"] as const;
export type StorageBucket = (typeof STORAGE_BUCKETS)[number];

/** 只在驱动工厂绑定，不扩业务桶枚举，也不允许每次调用选择物理桶。 */
export interface BackupTarget {
  readonly bucket: string;
  readonly prefix: string;
}
export interface BackupStreamInput {
  readonly key: string;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
  /** 未配置/取消时不调用；源须响应 signal 并在 return/finally 回收自己的管道。 */
  readonly body: (signal: AbortSignal) => AsyncIterable<Uint8Array>;
}
export interface BackupHeadInput {
  readonly key: string;
  readonly ifMatchEtag?: string;
  readonly signal: AbortSignal;
}
export interface BackupCopyInput {
  readonly srcKey: string;
  readonly dstKey: string;
  readonly ifMatchEtag: string;
  readonly signal: AbortSignal;
}
export type BackupHead =
  | { readonly exists: false; readonly size: 0 }
  | {
      readonly exists: true;
      readonly size: number;
      readonly etag: string;
      readonly sha256?: string;
    };
export interface BackupWriteResult {
  readonly etag: string;
  readonly size: number;
  readonly sha256: string;
}
export interface BackupCopyResult {
  readonly etag: string;
  readonly size: number;
  readonly sha256?: string;
}

/** 写入区的键前缀：直传只能落在这里，入库时条件复制到正式区（03 第 5.2 节） */
export const INCOMING_PREFIX = "incoming/";

export interface ObjectRef {
  bucket: StorageBucket;
  key: string;
}

export interface PresignedPost {
  url: string;
  /** 表单字段，原样放进 multipart 表单；文件字段名是 file，放最后 */
  fields: Record<string, string>;
  key: string;
  expiresAt: Date;
}

export interface StsCredential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt: Date;
  /** 云端签发起点；客户端避免以本机时间猜测签名生效时间。 */
  startTime?: Date;
}

export interface ObjectHead {
  exists: boolean;
  size: number;
  mime?: string;
  etag?: string;
  crc64?: string;
  versionId?: string;
}

export type { ProbeReport, AigcLabel, DocTextResult } from "./mediatool/schema.js";
export { DocTextResultSchema, DocTextResponseSchema } from "./mediatool/schema.js";

export interface PosterResult {
  /** 校验过的封面字节。上传用这一份，不要回头再按路径读文件 */
  bytes: Uint8Array;
  sizeBytes: number;
  width: number;
  height: number;
  /** 实际抽的时间点：片子比要求的时间点短时退回 0 */
  atMs: number;
}

export interface StampResult {
  /** 回读加标产物得到的体检报告，report.aigc 已核对与写入的相同 */
  report: ProbeReport;
  /** 调用端自己量的大小 */
  inputSizeBytes: number;
  outputSizeBytes: number;
}

export interface MediaToolClient {
  /** Container-only extraction; optional preserves existing fake/unconfigured clients. */
  docText?(input: {
    path: string;
    ext: "pdf" | "docx" | "txt";
    maxChars: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<ProviderResult<DocTextResult>>;
  /** 体检：媒体信息、顶层 box 顺序、AIGC 标签。demuxers 依次尝试 */
  probe(input: {
    path: string;
    demuxers: readonly MediaToolDemuxer[];
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<ProviderResult<ProbeReport>>;
  /** 抽 atMs 处的一帧存成 JPEG，写到 outPath（与输入同一个任务目录） */
  poster(input: {
    path: string;
    demuxer: MediaToolDemuxer;
    atMs: number;
    outPath: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<ProviderResult<PosterResult>>;
  /** 流拷贝重封装并写入 AIGC，再回读。aigcJson 用 aigcMetadataJson 生成。输入里已有标识会被覆盖：先体检再决定要不要调 */
  stampAigc(input: {
    path: string;
    outPath: string;
    aigcJson: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<ProviderResult<StampResult>>;
  /** 容器在不在、里面的 ffmpeg 是哪个版本 */
  health(signal?: AbortSignal): Promise<ProviderResult<MediaToolHealth>>;
  /** Fixed licensed font and RGBA canvas; text is never an ffmpeg expression. */
  watermarkPng?(input: {
    outPath: string;
    text: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<{ sizeBytes: number; width: 720; height: 96; sha256: string }>>;
}

export interface MediaWorkSession {
  readonly path: (name: "source.mp4" | "stamped.mp4" | "poster.jpg" | "watermark.png") => string;
  download(
    input: ObjectRef & { size: number; etag: string },
  ): Promise<ProviderResult<{ size: number; sha256: string }>>;
  publish(input: {
    name: "stamped.mp4" | "source.mp4" | "poster.jpg" | "watermark.png";
    dst: ObjectRef;
    contentIdentity: string;
    expectedSha256?: string;
    expectedSize?: number;
  }): Promise<ProviderResult<{ size: number; sha256: string; etag: string }>>;
}
export interface MediaWorkspace {
  run<T>(
    job: { id: string; attemptNo: number },
    signal: AbortSignal,
    action: (work: MediaWorkSession) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}
export interface ProductionMediaTools {
  readonly client: MediaToolClient;
  readonly workspace: MediaWorkspace;
  close(): Promise<void>;
}

export type VisionReadInput = ObjectRef & {
  readonly expiresSec: number;
  readonly source:
    { readonly kind: "image" } | { readonly kind: "video-frame"; readonly atMs: number };
};

export interface StorageProvider extends ProviderBase {
  /** sts：能不能签发临时密钥（大文件分块上传要用）；versioning：桶有没有开版本控制 */
  readonly capabilities: { readonly sts: boolean; readonly versioning: boolean };
  /** 物理桶名和地域；不含凭据，不是凭据发现链。 */
  readonly uploadLocation?: {
    readonly region: string;
    readonly buckets: Readonly<Record<StorageBucket, string>>;
  };
  /** 备份目标未配置时失败且不读取 body；未知长度加密流一次上传，不聚合完整对象。 */
  putBackupStream(input: BackupStreamInput): Promise<ProviderResult<BackupWriteResult>>;
  /** 只读本实例备份目标；可条件绑定 etag，404 是 exists:false。 */
  headBackup(input: BackupHeadInput): Promise<ProviderResult<BackupHead>>;
  /** 本实例备份目标内的条件服务端复制，拒绝源 etag 漂移。 */
  copyBackup(input: BackupCopyInput): Promise<ProviderResult<BackupCopyResult>>;
  /** 签名（写）：≤20MB 的预签名表单，直传到写入区。key 不以 incoming/ 开头即 rejected */
  presignPost(input: {
    bucket: StorageBucket;
    key: string;
    mime: string;
    maxBytes: number;
    expiresSec: number;
  }): Promise<ProviderResult<PresignedPost>>;
  /** 临时密钥：限定到一个键前缀。驱动没有这个能力时返回 unsupported */
  issueSts(input: {
    bucket: StorageBucket;
    keyPrefix: string;
    durationSec: number;
  }): Promise<ProviderResult<StsCredential>>;
  /** 读对象头。对象不存在不算失败：返回 exists 为 false */
  head(input: ObjectRef & { signal?: AbortSignal }): Promise<ProviderResult<ObjectHead>>;
  /** 有界读取文件头；confirm 只需前 4KB，可绑定对象 etag。 */
  readPrefix(
    input: ObjectRef & { bytes: number; ifMatchEtag?: string },
  ): Promise<ProviderResult<Uint8Array>>;
  /** 完整有界读取：HEAD 与 GET 绑定同一 etag，实际流不能超过 maxBytes；可取消。 */
  readObject(
    input: ObjectRef & { maxBytes: number; ifMatchEtag?: string; signal?: AbortSignal },
  ): Promise<ProviderResult<Uint8Array>>;
  /** HEAD/If-Match绑定的有界流读取；等待sink消费并回收网络流才返回。 */
  readTo(
    input: ObjectRef & {
      expectedSize: number;
      maxBytes: number;
      ifMatchEtag: string;
      signal: AbortSignal;
      sink: (chunk: Uint8Array) => Promise<void>;
    },
  ): Promise<ProviderResult<{ size: number; sha256: string }>>;
  /** 正式区固定键的原子条件流写；真实逐块长度/hash核对，不缓存完整对象。 */
  putStream(
    input: ObjectRef & {
      body: (signal: AbortSignal) => AsyncIterable<Uint8Array>;
      size: number;
      sha256: string;
      contentIdentity: string;
      contentType: string;
      ifAbsent: true;
      signal: AbortSignal;
    },
  ): Promise<ProviderResult<{ etag: string; size: number }>>;
  /** 系统文件写入正式区；只供服务端种子与系统生成文件，禁止端侧使用。 */
  putObject(
    input: ObjectRef & {
      body: Uint8Array;
      contentType: string;
      contentDisposition?: string;
      ifAbsent?: boolean;
      contentIdentity?: string;
    },
  ): Promise<ProviderResult<{ etag: string; size: number }>>;
  /** 复制入库：源对象的 etag 与 ifMatchEtag 相同才复制，并改写内容类型；不同返回 rejected */
  copy(input: {
    src: ObjectRef;
    dst: ObjectRef;
    ifMatchEtag: string;
    contentType: string;
    contentDisposition?: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<{ etag: string }>>;
  /** 签名（读）：签发有时限的读地址 */
  presignGet(input: {
    bucket: StorageBucket;
    key: string;
    expiresSec: number;
    /** 给了就按附件下载，并用这个文件名 */
    downloadName?: string;
    /** 显式覆盖响应的 Content-Disposition；不传保持旧行为。 */
    disposition?: "inline" | "attachment";
  }): Promise<ProviderResult<{ url: string; expiresAt: Date }>>;
  /** 固定视觉处理的短期 GET 签名；不证明产物、帧时刻、权限或对象归属。 */
  presignVisionGet(
    input: VisionReadInput,
  ): Promise<ProviderResult<{ url: string; expiresAt: Date }>>;
  /** 删除。对象本来就不存在也算成功 */
  delete(input: ObjectRef & { signal?: AbortSignal }): Promise<ProviderResult<void>>;
  /** 移除该精确对象的删除标记；无可恢复版本须明确拒绝，不伪造成功。 */
  restoreVersions(input: ObjectRef & { signal: AbortSignal }): Promise<ProviderResult<void>>;
  /** 删除该精确对象全部历史版本与删除标记；可取消、重复调用安全。 */
  eraseVersions(input: ObjectRef & { signal: AbortSignal }): Promise<ProviderResult<void>>;
  /** 尽力中止指定 incoming 对象的未完成分块；不得处理同前缀的其他对象。 */
  abortMultipart(input: ObjectRef): Promise<ProviderResult<void>>;
}

// ---------- media：体检、转码、打包、视频审核（M0 只有方法位，任务书 第 11 节第 7 项） ----------

export interface MediaProbeReport {
  durationMs: number;
  width: number;
  height: number;
  videoCodec: string;
  hasAudio: boolean;
  sizeBytes: number;
}

export interface MediaJob {
  jobId: string;
  state: "submitted" | "done";
  /** false：走的是本地小文件通道，直接算完成，没有真正处理 */
  processed: boolean;
}

export interface MediaRemoteJob {
  readonly jobId: string;
  readonly state: "submitted" | "running" | "succeeded" | "failed" | "canceled";
  readonly processed: boolean;
  readonly userData?: string;
  /** 只含经驱动白名单解析的技术结果，禁止原始Operation/UserInfo/审核正文。 */
  readonly output: {
    readonly width?: number;
    readonly height?: number;
    readonly durationMs?: number;
    readonly sizeBytes?: string;
    readonly etag?: string;
  };
}

/** CI moderation projection. No recognized text, URLs, snapshots, or raw provider objects. */
export interface MediaAuditResult {
  readonly verdict: Exclude<ContentVerdict, "pending">;
  readonly processed: boolean;
  readonly labels?: readonly string[];
}
export interface MediaAuditJob {
  readonly jobId: string;
  readonly dataId: string;
  readonly state: "submitted" | "running" | "succeeded" | "failed";
  readonly processed: boolean;
  readonly verdict?: Exclude<ContentVerdict, "pending">;
  readonly labels?: readonly string[];
}

export interface MediaProvider extends ProviderBase {
  /** 体检：分辨率、时长、编码、音轨。没有真正体检时 report 为 null */
  probe(input: {
    src: ObjectRef;
    signal?: AbortSignal;
  }): Promise<ProviderResult<{ processed: boolean; report: MediaProbeReport | null }>>;
  /** 转码 */
  transcode(input: {
    src: ObjectRef;
    signal?: AbortSignal;
    dst: ObjectRef;
    template: string;
    userData: string;
    watermarks?: readonly (
      | { readonly templateId: string }
      | {
          readonly text: string;
          readonly position: "Center" | "TopRight";
          readonly fontSize: number;
          readonly transparency: number;
        }
      | { readonly image: ObjectRef; readonly position: "Center"; readonly transparency: number }
    )[];
  }): Promise<ProviderResult<MediaJob>>;
  /** 打包：把同一个桶里的几个对象打成一个压缩包 */
  pack(input: {
    bucket: StorageBucket;
    signal?: AbortSignal;
    items: Array<{ key: string; name: string }>;
    dstKey: string;
    userData: string;
  }): Promise<ProviderResult<MediaJob>>;
  /** 同步图片审核；保留原方法名，视频走 auditVideo。 */
  audit(input: {
    src: ObjectRef;
    signal?: AbortSignal;
    scenes: string[];
    userData: string;
  }): Promise<
    ProviderResult<{
      verdict: ContentVerdict;
      processed: boolean;
      jobId?: string;
      labels?: readonly string[];
    }>
  >;
  /** 同步审核真实 UTF-8 文本，驱动只返回有限结论，不返回正文。 */
  auditText(input: {
    bucket: StorageBucket;
    text: string;
    userData: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<MediaAuditResult>>;
  /** 异步视频审核。未知提交不得自动重发。 */
  auditVideo(input: {
    src: ObjectRef;
    userData: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<MediaAuditJob>>;
  /** 精确查询已知审核 JobId，并核对实际 Object/DataId。 */
  describeAudit(input: {
    src: ObjectRef;
    jobId: string;
    userData: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<MediaAuditJob>>;
  /** 旧临时实现可缺省，统一执行器须受控拒绝缺失能力。 */
  describe?(input: {
    jobId: string;
    family: "media" | "file";
    signal?: AbortSignal;
  }): Promise<ProviderResult<MediaRemoteJob>>;
  find?(input: {
    family: "media" | "file";
    tag: string;
    userData: string;
    src?: ObjectRef;
    createdAfter: Date;
    createdBefore: Date;
    signal?: AbortSignal;
  }): Promise<ProviderResult<{ job: MediaRemoteJob | null; complete: boolean }>>;
  cancel?(input: {
    jobId: string;
    family: "media" | "file";
    signal?: AbortSignal;
  }): Promise<ProviderResult<void>>;
}

// ---------- sms：员工激活码、订阅消息的补发、值班告警 ----------

export const SMS_TODO_ITEMS = [
  "样片确认",
  "广告确认",
  "成片交付",
  "上线确认",
  "资料审核",
  "工单回复",
  "积分变动",
  "服务到期",
  "下架确认",
  "账号安全",
  "付款成功",
  "订购成功",
  "方案确认",
  "发票开具",
  "成员变动",
  "素材反馈",
  "退款结果",
] as const;

/** D6 §2.10 固定变量顺序/有限业务上限；业主批准长度只能进一步收窄。 */
export const SMS_TEMPLATE_PARAMS: Readonly<
  Record<string, readonly { name: string; maxLen: number }[]>
> = {
  verify_code: [{ name: "code", maxLen: 6 }],
  review_result: [
    { name: "result", maxLen: 12 },
    { name: "reason", maxLen: 64 },
  ],
  sample_pending: [{ name: "item", maxLen: 12 }],
  launch_remind: [
    { name: "date", maxLen: 10 },
    { name: "channel", maxLen: 20 },
    { name: "drama", maxLen: 40 },
  ],
  plan_expiring: [
    { name: "plan", maxLen: 40 },
    { name: "expiry_date", maxLen: 10 },
    { name: "points", maxLen: 12 },
  ],
  offline_remind: [
    { name: "drama", maxLen: 40 },
    { name: "offline_date", maxLen: 10 },
  ],
  generic_todo: [{ name: "item", maxLen: 12 }],
  account_notice: [],
  ops_alert: [{ name: "rule_name", maxLen: 64 }],
};

export interface SmsTemplateBinding {
  readonly templateKey: string;
  readonly kind: "verify" | "notice";
  readonly providerTemplateId: string | null;
  readonly signName: string | null;
  readonly status: string;
  readonly params: readonly { readonly name: string; readonly maxLen: number }[];
}

export type SmsSendResult =
  | ProviderSuccess<{ requestId: string; providerMsgId: string }>
  | (ProviderFailure & {
      readonly providerCode?: string;
      readonly requestId?: string;
      /** unknown 禁止自动重发；同步成功也不代表已到达。 */
      readonly acceptance?: "not_accepted" | "unknown";
    });

export interface SmsBalance {
  /** 完整有效套餐剩余条数；当前驱动无完整性证据而不返回此值。 */
  readonly remaining: number;
  readonly observedAt: Date;
}

export interface SmsProvider extends ProviderBase {
  sendTemplate(input: {
    phone: string;
    template: SmsTemplateBinding;
    params: Readonly<Record<string, string>>;
    signal?: AbortSignal;
  }): Promise<SmsSendResult>;
  checkBalance(input?: { signal?: AbortSignal }): Promise<ProviderResult<SmsBalance>>;
  /** 员工激活码 */
  sendActivationCode(input: {
    phone: string;
    code: string;
    signal?: AbortSignal;
  }): Promise<NotificationProviderResult<void>>;
  /** 订阅消息的补发：订阅消息发不出去时改发短信 */
  sendSubscribeFallback(input: {
    phone: string;
    templateKey: string;
    params: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<NotificationProviderResult<void>>;
  /** 值班告警 */
  sendOncallAlert(input: {
    phones: string[];
    title: string;
    content: string;
    signal?: AbortSignal;
  }): Promise<NotificationProviderResult<void>>;
}

// ---------- ocr：营业执照识别、行业许可证字段抽取 ----------

export interface BusinessLicenseFields {
  name: string;
  /** 统一社会信用代码 */
  uscc: string;
  /** 法定代表人、经营者或负责人 */
  principal: string;
  principalRole?: "legal_rep" | "operator" | "branch_head";
  businessScope?: string;
  /** 官方原始响应JSON，仅供加密短期留证；不进入API识别字段或日志。 */
  raw?: string;
  address?: string;
  /** 只从实际识别类型映射；未知不推断企业/个体，也不据此通过比对。 */
  subjectType?: "enterprise" | "individual" | "branch" | "unknown";
  subjectTypeText?: string;
  /** 原始营业期限文本与确切解析出的起始日期；不能解析时不补日期。 */
  periodText?: string;
  validFrom?: string;
  /** 营业期限止：YYYY-MM-DD，或 long_term */
  validTo?: string;
  /** 翻拍、复印件之类的告警 */
  warnings: string[];
}

export interface OcrProvider extends ProviderBase {
  /** 银行回单图片或PDF首页；不可据此确认到账。 */
  recognizeBankReceipt(input: {
    fileUrl: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<BankReceiptFields>>;
  /** 营业执照识别 */
  recognizeBusinessLicense(input: {
    imageUrl: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<BusinessLicenseFields>>;
  /** 行业许可证字段抽取 */
  extractLicenseFields(input: {
    fileUrl: string;
    fieldNames: string[];
  }): Promise<ProviderResult<{ fields: Record<string, string> }>>;
}

// ---------- asr：录音转写 ----------

export interface AsrSubmissionFailure extends ProviderFailure {
  /** unknown 不能据通用 unavailable 自动重提；只能由本地任务归属继续处置。 */
  readonly acceptance: "not_accepted" | "unknown";
  readonly code:
    | "unconfigured"
    | "invalid_input"
    | "aborted"
    | "closed"
    | "timeout"
    | "transport"
    | "http_error"
    | "invalid_response"
    | "provider_rejected"
    | "unknown_outcome";
}
export type AsrSubmissionResult =
  | ProviderSuccess<{
      /** 官方 uint64 十进制原值；24小时有效、跨日可能重复，不是业务幂等键。 */
      taskId: string;
      requestId: string;
    }>
  | AsrSubmissionFailure;
export interface AsrSegment {
  text: string;
  startMs: number;
  endMs: number;
}
export type AsrTaskStatus = {
  taskId: string;
  requestId: string;
} & (
  | { state: "waiting" | "doing" }
  | { state: "failed"; code: "recognition_failed" }
  | { state: "succeeded"; text: string; durationSec: number; segments: AsrSegment[] }
);

export interface AsrProvider extends ProviderBase {
  /** 录音转写 */
  transcribe(input: {
    url: string;
  }): Promise<ProviderResult<{ text: string; durationSec?: number }>>;
  /** 一次异步受理，不自行重试；url 只能由拥有者提供短期授权地址。 */
  submit(input: {
    url: string;
    signal?: AbortSignal;
    /** 仅本地任务标识；回调目的地由构造配置固定，不接受逐次 URL。 */
    callback?: Readonly<{ mediaJobId: string }>;
  }): Promise<AsrSubmissionResult>;
  query(input: { taskId: string; signal?: AbortSignal }): Promise<ProviderResult<AsrTaskStatus>>;
}

// ---------- llm：素材识别打标、要点提炼 ----------

export type LlmAssetKind = "image" | "video" | "audio" | "document";

export interface LlmProvider extends ProviderBase {
  /** 素材识别打标。图片与视频给 url；录音与文档给转写或抽出的 text */
  tagAsset(input: {
    kind: LlmAssetKind;
    url?: string;
    text?: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<{ description: string; tags: string[] }>>;
  /** 要点提炼 */
  extractKeyPoints(input: {
    text: string;
    maxPoints?: number;
    signal?: AbortSignal;
  }): Promise<ProviderResult<{ points: string[] }>>;
  /** D5 完整结构化建议；词表由调用者提供真实分维快照，不写人工复核结果。 */
  summarizeAsset(input: LlmDigestInput): Promise<ProviderResult<LlmDigest>>;
  /** 调用者提供同源可信图片/视频帧；只输出视觉事实，不推定身份或肖像授权。 */
  analyzeVision(input: LlmVisionInput): Promise<ProviderResult<LlmVision>>;
}

// ---------- wecom：员工通知、“联系我”二维码与加好友回调、微信客服 ----------

export type WecomCallbackEvent =
  /** 商家加了服务经理的好友。state 是生成“联系我”二维码时带的自定义参数 */
  | { kind: "contact_added"; userId: string; externalUserId: string; state?: string }
  | { kind: "other"; eventType: string };

export interface WecomProvider extends ProviderBase {
  /** 机器人配置独立于自建应用；缺省表示该窄能力未配置。 */
  readonly capabilities?: { readonly robot: boolean };
  /** 后台内嵌扫码的单次 code 换员工 userid；真实驱动交 G7-A。 */
  exchangeWebLoginCode(input: { code: string }): Promise<ProviderResult<{ userid: string }>>;
  /** 员工通知：自建应用消息 */
  sendAppMessage(input: {
    toUser: string;
    title: string;
    description: string;
    url?: string;
    signal?: AbortSignal;
  }): Promise<NotificationProviderResult<void>>;
  /** 群机器人文本；成功只证明服务商明确受理，不证明群成员已收到。 */
  sendRobotMessage(input: {
    title: string;
    content: string;
    mentionAll: boolean;
    signal?: AbortSignal;
  }): Promise<NotificationProviderResult<void>>;
  /** “联系我”二维码 */
  createContactWay(input: {
    userId: string;
    state: string;
  }): Promise<ProviderResult<{ configId: string; qrCodeUrl: string }>>;
  /** 加好友回调：验签并解密 */
  verifyAndDecryptCallback(input: {
    query: Record<string, string>;
    rawBody: string;
  }): Promise<ProviderResult<WecomCallbackEvent>>;
  /** 微信客服：取在线客服的接待链接 */
  getKfLink(input: { scene?: string }): Promise<ProviderResult<{ url: string }>>;
}

// ---------- esign：授权书数字签名 ----------

export interface EsignProvider extends ProviderBase {
  /**
   * 授权书签署。mode 为 certificate 时带数字签名；为 stamp 时是图片章：章在文书渲染时已经盖上，
   * 这里不加数字签名，原样返回。stg、prod 下图片章须显式开关（ADR-039 的例外）。
   */
  seal(input: { pdf: Uint8Array }): Promise<
    ProviderResult<{
      pdf: Uint8Array;
      mode: "certificate" | "stamp";
      certSerial?: string;
      signedAt?: Date;
    }>
  >;
}

// ---------- invoice：自动开票（V1.1+，现在只留接口与未配置实现） ----------

export interface InvoiceProvider extends ProviderBase {
  /** 自动开票 */
  issue(input: {
    requestNo: string;
    title: string;
    taxNo?: string;
    amountFen: number;
  }): Promise<ProviderResult<{ invoiceNo: string }>>;
}

// ---------- mail：电子发票发送 ----------

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface MailProvider extends ProviderBase {
  /** 发一封邮件。V1.0 只用来发电子发票 */
  send(input: {
    to: string;
    subject: string;
    text: string;
    attachments?: MailAttachment[];
    signal?: AbortSignal;
  }): Promise<NotificationProviderResult<{ messageId: string }>>;
}

// ---------- 十二个接口的汇总 ----------

export interface Providers {
  wechat: WechatProvider;
  wechatPay: WechatPayProvider;
  sms: SmsProvider;
  storage: StorageProvider;
  media: MediaProvider;
  ocr: OcrProvider;
  asr: AsrProvider;
  llm: LlmProvider;
  wecom: WecomProvider;
  esign: EsignProvider;
  invoice: InvoiceProvider;
  mail: MailProvider;
}

export type ProviderName = keyof Providers;

/** 十二个接口的名字，顺序照 ADR-039。状态打印按这个顺序出 */
export const PROVIDER_NAMES = [
  "wechat",
  "wechatPay",
  "sms",
  "storage",
  "media",
  "ocr",
  "asr",
  "llm",
  "wecom",
  "esign",
  "invoice",
  "mail",
] as const satisfies readonly ProviderName[];

/** 一个接口里的方法名：值是函数的键 */
export type ProviderMethodName<P> = {
  [K in keyof P]-?: NonNullable<P[K]> extends (...args: never[]) => unknown ? K : never;
}[keyof P] &
  string;

/**
 * 每个接口的方法清单。外呼前钩子的包装、未配置实现与替身的用例都照它逐个方法走。
 * 清单里写了接口没有的名字，下面的 satisfies 报错；接口加了方法而这里没列，再下面的断言报错。
 */
export const PROVIDER_METHODS = {
  wechat: [
    "code2Session",
    "getPhoneNumber",
    "sendSubscribeMessage",
    "createMiniProgramCode",
    "checkText",
    "checkImage",
  ],
  wechatPay: [
    "signMiniProgramPay",
    "createJsapiOrder",
    "verifyAndDecryptNotification",
    "queryByOutTradeNo",
    "closeOrder",
    "createRefund",
    "queryRefund",
    "fetchTradeBill",
    "fetchVerifiedTradeBill",
  ],
  sms: [
    "sendActivationCode",
    "sendSubscribeFallback",
    "sendOncallAlert",
    "sendTemplate",
    "checkBalance",
  ],
  storage: [
    "presignPost",
    "issueSts",
    "head",
    "readPrefix",
    "readObject",
    "putObject",
    "copy",
    "presignGet",
    "presignVisionGet",
    "delete",
    "restoreVersions",
    "eraseVersions",
    "abortMultipart",
    "readTo",
    "putStream",
    "putBackupStream",
    "headBackup",
    "copyBackup",
  ],
  media: [
    "probe",
    "transcode",
    "pack",
    "audit",
    "describe",
    "find",
    "cancel",
    "auditText",
    "auditVideo",
    "describeAudit",
  ],
  ocr: ["recognizeBusinessLicense", "extractLicenseFields", "recognizeBankReceipt"],
  asr: ["transcribe", "submit", "query"],
  llm: ["tagAsset", "extractKeyPoints", "summarizeAsset", "analyzeVision"],
  wecom: [
    "sendAppMessage",
    "createContactWay",
    "verifyAndDecryptCallback",
    "getKfLink",
    "exchangeWebLoginCode",
    "sendRobotMessage",
  ],
  esign: ["seal"],
  invoice: ["issue"],
  mail: ["send"],
} as const satisfies { readonly [K in ProviderName]: readonly ProviderMethodName<Providers[K]>[] };

type Assert<T extends true> = T;

/** 编译期断言：PROVIDER_NAMES 列全了十二个接口 */
export type ProviderNamesAreComplete = Assert<
  [Exclude<ProviderName, (typeof PROVIDER_NAMES)[number]>] extends [never] ? true : false
>;

/** 编译期断言：PROVIDER_METHODS 列全了每个接口的方法 */
export type ProviderMethodsAreComplete = Assert<
  {
    [K in ProviderName]: [
      Exclude<ProviderMethodName<Providers[K]>, (typeof PROVIDER_METHODS)[K][number]>,
    ] extends [never]
      ? true
      : false;
  }[ProviderName]
>;

// ---------- 外呼前钩子（任务书 第 11 节第 3 项；D7 第 2.3 节规则 5） ----------

export interface ProviderCall {
  provider: ProviderName;
  method: string;
}

/**
 * 每个 Provider 方法的入口先调它一次。缺省空转；接上 kernel 的事务标记之后，在事务里外呼会在这里抛错。
 * 它抛的错不归入 ProviderResult，原样抛给调用方：那是程序错误，不是外部服务没办成。
 */
export type BeforeProviderCall = (call: ProviderCall) => void;

/**
 * 给一个 Provider 包上外呼前钩子：清单里的每个方法，进入时先调一次钩子，再调原实现。
 * 其余的属性（status、configured、替身的编排入口）原样透传，读写都落在原对象上。
 */
export function withBeforeCall<K extends ProviderName, P extends Providers[K]>(
  name: K,
  provider: P,
  beforeCall: BeforeProviderCall,
): P {
  const methods: ReadonlySet<string> = new Set(PROVIDER_METHODS[name]);
  return new Proxy(provider, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof property !== "string" || !methods.has(property) || typeof value !== "function") {
        return value;
      }
      return async (...args: unknown[]): Promise<unknown> => {
        beforeCall({ provider: name, method: property });
        return Reflect.apply(value, target, args);
      };
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  });
}

/** 给十二个接口都包上外呼前钩子。传进来的可以是替身的集合：返回值的类型不变 */
export function guardProviders<T extends Providers>(
  providers: T,
  beforeCall: BeforeProviderCall,
): T {
  const guarded = { ...providers };
  // 同一个对象的另一个名字：按接口名逐个换成包好的
  const slots: Record<ProviderName, unknown> = guarded;
  for (const name of PROVIDER_NAMES) {
    slots[name] = withBeforeCall(name, providers[name], beforeCall);
  }
  return guarded;
}
