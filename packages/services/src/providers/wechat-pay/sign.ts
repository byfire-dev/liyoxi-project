// 微信支付 APIv3 的三种签名串、RSA-SHA256 签名与验签（03 第 1.4 节；h01 第 3.1 节；ADR-016）。
// 只用 node:crypto。签名串的格式出自官方文档（pay.weixin.qq.com/doc/v3/merchant）：
//   请求签名 4012365336；应答与回调验签 4013053249；小程序调起支付签名 4012365341。
// 每一行都以 \n 结尾，包括最后一行。验签串里的报文主体用原始字节，不经任何解析与再序列化。

import { createSign, createVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";

export const AUTH_SCHEME = "WECHATPAY2-SHA256-RSA2048";

/** 平台探测流量的签名前缀：照常验签（必然失败），只用它给失败的结果打标记 */
export const PROBE_SIGNATURE_PREFIX = "WECHATPAY/SIGNTEST/";

export interface RequestSignParts {
  method: string;
  /** 去掉域名的地址，带查询串；发出去的与签名用的必须是同一个字符串 */
  pathWithQuery: string;
  /** 秒级时间戳 */
  timestamp: string;
  nonce: string;
  /** 请求体原文；没有请求体时给空串 */
  body: string;
}

/** 请求签名串：方法、地址、时间戳、随机串、请求体，一共五行 */
export function requestSignMessage(parts: RequestSignParts): string {
  const { method, pathWithQuery, timestamp, nonce, body } = parts;
  return `${method}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${body}\n`;
}

/** 应答与回调的验签串：时间戳、随机串、报文主体，一共三行。body 给原始字节 */
export function responseSignMessage(timestamp: string, nonce: string, body: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), body, Buffer.from("\n")]);
}

/** 小程序调起支付的签名串：appId、时间戳、随机串、prepay_id=…，一共四行 */
export function miniProgramPaySignMessage(parts: {
  appId: string;
  timeStamp: string;
  nonceStr: string;
  prepayId: string;
}): string {
  return `${parts.appId}\n${parts.timeStamp}\n${parts.nonceStr}\nprepay_id=${parts.prepayId}\n`;
}

/** RSA-SHA256（PKCS#1 v1.5）签名，返回 base64 */
export function rsaSign(message: string | Uint8Array, privateKey: KeyObject): string {
  return createSign("RSA-SHA256").update(message).sign(privateKey, "base64");
}

/** RSA-SHA256 验签。签名不是规范的 base64（含探测前缀的那种）一律不通过；不抛错 */
export function rsaVerify(
  message: string | Uint8Array,
  signature: string,
  publicKey: KeyObject,
): boolean {
  const bytes = Buffer.from(signature, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== signature) return false;
  try {
    return createVerify("RSA-SHA256").update(message).verify(publicKey, bytes);
  } catch {
    return false;
  }
}

/** 时间戳与本机相差的上限（约定 C6；官方文档 4013053420 第 2.1 节） */
export const MAX_SKEW_MS = 5 * 60 * 1000;

/** 时间戳（秒）与此刻相差是否在 5 分钟之内。不是纯数字的算超限 */
export function withinSkew(timestamp: string, now: Date): boolean {
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  return Math.abs(now.getTime() - Number(timestamp) * 1000) <= MAX_SKEW_MS;
}

/** Authorization 头：认证类型加五个字段（官方文档说明五项没有顺序要求） */
export function authorizationHeader(fields: {
  mchid: string;
  serialNo: string;
  nonce: string;
  timestamp: string;
  signature: string;
}): string {
  const { mchid, serialNo, nonce, timestamp, signature } = fields;
  return (
    `${AUTH_SCHEME} mchid="${mchid}",nonce_str="${nonce}",signature="${signature}",` +
    `timestamp="${timestamp}",serial_no="${serialNo}"`
  );
}
