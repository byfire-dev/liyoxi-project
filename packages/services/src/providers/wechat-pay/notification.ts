// 回调入口：验签 + 解密（h01 第 2.1 节第 6–9 步、第 3.1、3.2 节）。只做到“给出判别结果”：
// 落库、应答协议、到 WEBHOOK_* 错误码的映射归回调框架（G2-0、G4-A）。
//
// 顺序照 h01：取四个请求头 → 按序列号找验签身份 → 对原始字节验签 → 时间戳与注入的时钟相差不超过 5 分钟
// → 解析外层 → 解密 → 核对必需字段。输入的 rawBody 必须是网关收到的原始字节（或其未改动的文本），
// 不得是解析后再序列化的结果。探测签名照常验签（必然失败），只在失败结果上打 probe 标记。

import type { WechatPayConfig } from "./config.js";
import type {
  NotificationFailureKind,
  NotificationFailure,
  NotificationSuccess,
  NotificationResult,
} from "../types.js";
import { createApiV3Keyring, createVerifierTable, AEAD_ALGORITHM } from "./keyring.js";
import type { ApiV3Keyring, ResourceCipher, VerifierTable } from "./keyring.js";
import { fen, isObject, mapRefund, mapTransaction, parseObject, text } from "./mapping.js";
import type { Json } from "./mapping.js";
import { PROBE_SIGNATURE_PREFIX, responseSignMessage, rsaVerify, withinSkew } from "./sign.js";

export type {
  NotificationFailureKind,
  NotificationFailure,
  NotificationSummary,
  NotificationSuccess,
  NotificationResult,
} from "../types.js";
export interface NotificationDeps {
  verifiers: VerifierTable;
  keyring: ApiV3Keyring;
  now: () => Date;
}

const fail = (
  kind: NotificationFailureKind,
  detail: string,
  probe = false,
): NotificationFailure => ({
  ok: false,
  kind,
  probe,
  detail,
});

/** 验签并解密一条回调 */
export function verifyAndDecrypt(
  deps: NotificationDeps,
  input: { headers: Record<string, string | undefined>; rawBody: Uint8Array | string },
): NotificationResult {
  const headers = new Map(
    Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value ?? ""]),
  );
  const timestamp = headers.get("wechatpay-timestamp") ?? "";
  const nonce = headers.get("wechatpay-nonce") ?? "";
  const signature = headers.get("wechatpay-signature") ?? "";
  const serial = headers.get("wechatpay-serial") ?? "";
  const probe = signature.startsWith(PROBE_SIGNATURE_PREFIX);
  if (!timestamp || !nonce || !signature || !serial) {
    return fail("signature_invalid", "验签用的四个请求头不全", probe);
  }
  const identity = deps.verifiers.lookup(serial);
  if (!identity) return fail("key_not_found", "验签身份没有配置", probe);

  const body = typeof input.rawBody === "string" ? Buffer.from(input.rawBody) : input.rawBody;
  if (!rsaVerify(responseSignMessage(timestamp, nonce, body), signature, identity.publicKey)) {
    return fail("signature_invalid", probe ? "签名探测流量" : "签名与报文对不上", probe);
  }
  if (!withinSkew(timestamp, deps.now())) {
    return fail("timestamp_skewed", "时间戳与本机相差超过 5 分钟");
  }

  const outer = parseObject(Buffer.from(body).toString("utf8"));
  const id = text(outer?.id);
  const eventType = text(outer?.event_type);
  const cipher = outer?.resource;
  if (!id || !eventType || !isObject(cipher)) {
    return fail("payload_invalid", "报文外层缺 id、event_type 或 resource");
  }
  const { algorithm, ciphertext, nonce: cipherNonce } = cipher;
  if (algorithm !== AEAD_ALGORITHM || !text(ciphertext) || !text(cipherNonce)) {
    return fail("payload_invalid", "resource 的算法、密文或随机串不合规");
  }
  const resourceCipher = cipher as unknown as ResourceCipher;
  const opened = deps.keyring.decrypt(resourceCipher);
  if (!opened) return fail("decrypt_failed", "验签通过但解密失败");
  const resource = parseObject(opened.plaintext);
  if (!resource) return fail("payload_invalid", "解密后的资源不是 JSON 对象");

  const mapped = mapResource(id, eventType, serial, resource);
  if (!mapped) return fail("payload_invalid", `解密后的 ${eventType} 缺必需字段或状态不合规`);
  return { ok: true, id, eventType, serial, kid: opened.kid, resourceCipher, resource, ...mapped };
}

type Mapped = Pick<NotificationSuccess, "notification" | "summary">;

/**
 * 归一成接口的类型，并给出不含 openid 的摘要。必需字段与取值约束照 h01 第 3.1、3.2 节；不满足返回 null：
 * 支付成功通知的 trade_state 只认 SUCCESS；退款通知的 refund_status 要与事件类型是同一个（REFUND.SUCCESS
 * 配 SUCCESS，余类推，所以 PROCESSING 一律不收），成功的要带 success_time。处理事务 T1 不做业务判断，
 * 这几样在这里拦。商户号、AppID 是否属于本系统不在这里判（字段原样给出，归处理函数）。
 */
function mapResource(id: string, eventType: string, serial: string, r: Json): Mapped | null {
  const transactionId = text(r.transaction_id);
  if (eventType === "TRANSACTION.SUCCESS") {
    const transaction = mapTransaction(r);
    if (!transaction || !text(r.mchid) || !text(r.appid) || !transactionId) return null;
    const { outTradeNo, tradeState, amountFen, payerOpenid, successAt } = transaction;
    if (tradeState !== "SUCCESS" || !amountFen || !payerOpenid || !successAt) return null;
    return {
      notification: { kind: "transaction", id, transaction },
      summary: {
        serial,
        outTradeNo,
        transactionId,
        state: tradeState,
        amountFen,
        successAt: successAt.toISOString(),
      },
    };
  }
  if (["REFUND.SUCCESS", "REFUND.ABNORMAL", "REFUND.CLOSED"].includes(eventType)) {
    const refund = mapRefund(r);
    const successAt = text(r.success_time);
    const total = fen(isObject(r.amount) ? r.amount.total : undefined);
    if (!refund || !text(r.mchid) || !transactionId || total === undefined) return null;
    if (eventType !== `REFUND.${refund.status}`) return null;
    if (successAt === undefined && refund.status === "SUCCESS") return null;
    if (successAt !== undefined && Number.isNaN(Date.parse(successAt))) return null;
    const successDate = successAt === undefined ? undefined : new Date(successAt);
    return {
      notification: {
        kind: "refund",
        id,
        refund: { ...refund, ...(successDate === undefined ? {} : { successAt: successDate }) },
      },
      summary: {
        serial,
        outTradeNo: refund.outTradeNo,
        outRefundNo: refund.outRefundNo,
        transactionId,
        refundId: refund.refundId,
        state: refund.status,
        amountFen: refund.refundFen,
        successAt: successDate?.toISOString(),
      },
    };
  }
  return { notification: null, summary: null };
}

/** 驱动与协议替身共用已验证的纯密码学能力；构造与调用均零网络。 */
export function createWechatPayNotificationCrypto(
  config: Pick<WechatPayConfig, "verifiers" | "apiV3Keys">,
  now: () => Date,
) {
  const deps = {
    verifiers: createVerifierTable(config.verifiers),
    keyring: createApiV3Keyring(config.apiV3Keys.current, config.apiV3Keys.previous),
    now,
  };
  return {
    verifyNotification: (input: Parameters<typeof verifyAndDecrypt>[1]) =>
      verifyAndDecrypt(deps, input),
    reopenResource: (resource: ResourceCipher, kid: string) =>
      parseObject(deps.keyring.decrypt(resource, kid)?.plaintext ?? ""),
  };
}
