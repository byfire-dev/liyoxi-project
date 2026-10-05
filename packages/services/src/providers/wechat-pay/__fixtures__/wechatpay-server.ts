// 用例的支架：扮演“微信支付一侧”，现场生成密钥对，给应答与通知签名，给通知的资源加密。
// 这里的密钥都是运行时生成的测试密钥，不入库（任务书 第 11 节第 2 项）。只给用例与向量生成脚本用。

import { createCipheriv, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { responseSignMessage, rsaSign } from "../sign.js";

/** 一看就是假值的测试 APIv3 密钥：32 个字节。运行时拼出来，不作为字面量入库 */
export const testApiV3Key = (tag: string): string =>
  `lyx-test-${tag}-`.padEnd(32, "0").slice(0, 32);

export interface TestIdentity {
  serial: string;
  privateKey: KeyObject;
  publicKeyPem: string;
  privateKeyPem: string;
}

/** 现场生成一对 RSA-2048 密钥 */
export function generateIdentity(serial: string): TestIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    serial,
    privateKey,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** DER 的一个节点：标签、长度、内容 */
function der(tag: number, ...parts: Uint8Array[]): Buffer {
  const body = Buffer.concat(parts);
  const length =
    body.length < 0x80
      ? [body.length]
      : body.length < 0x100
        ? [0x81, body.length]
        : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

/**
 * 现场生成一张自签名的测试证书（X.509 v1，RSA-SHA256），扮演“平台证书”：序列号就是验签身份的序列号。
 * Node 没有签发证书的接口，这里手写最小的 DER。只给用例用。
 */
export function generateCertificateIdentity(): TestIdentity & { certificatePem: string } {
  const serialBytes = Buffer.concat([Buffer.from([0x4d]), randomBytes(19)]);
  const identity = generateIdentity(serialBytes.toString("hex").toUpperCase());
  const algorithm = der(0x30, Buffer.from("06092a864886f70d01010b0500", "hex"));
  const commonName = der(
    0x30,
    Buffer.from("0603550403", "hex"),
    der(0x0c, Buffer.from("lyx-test")),
  );
  const name = der(0x30, der(0x31, commonName));
  const validity = der(
    0x30,
    der(0x17, Buffer.from("260101000000Z")),
    der(0x17, Buffer.from("460101000000Z")),
  );
  const spki = createPublicKey(identity.publicKeyPem).export({ type: "spki", format: "der" });
  const tbs = der(0x30, der(0x02, serialBytes), algorithm, name, validity, name, spki);
  const signature = Buffer.from(rsaSign(tbs, identity.privateKey), "base64");
  const certificate = der(0x30, tbs, algorithm, der(0x03, Buffer.from([0]), signature));
  const lines = certificate.toString("base64").match(/.{1,64}/g) ?? [];
  const certificatePem = `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
  return { ...identity, certificatePem };
}

/** AEAD_AES_256_GCM 加密：密文后面跟 16 字节的认证标签，整体 base64 */
export function seal(
  key: string,
  plaintext: string,
  nonce: string,
  associatedData: string,
): string {
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "utf8"), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]).toString("base64");
}

/** 以微信支付的身份给一段报文签名，给出四个请求头（应答与回调同一套） */
export function signedHeaders(
  platform: TestIdentity,
  body: string | Uint8Array,
  at: Date,
  nonce = randomBytes(16).toString("hex"),
): Record<string, string> {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  return {
    "Wechatpay-Timestamp": timestamp,
    "Wechatpay-Nonce": nonce,
    "Wechatpay-Serial": platform.serial,
    "Wechatpay-Signature": rsaSign(
      responseSignMessage(timestamp, nonce, bytes),
      platform.privateKey,
    ),
  };
}

export interface NotificationSpec {
  id: string;
  eventType: string;
  /** 解密后的资源 */
  resource: unknown;
  originalType?: string;
  /** 加密用的随机串，12 个字符；不给现场生成 */
  nonce?: string;
}

/** 造一条真实结构的通知报文（外层 JSON，资源已加密） */
export function notificationBody(apiV3Key: string, spec: NotificationSpec): string {
  const originalType = spec.originalType ?? spec.eventType.split(".")[0]?.toLowerCase() ?? "";
  const nonce = spec.nonce ?? randomBytes(6).toString("hex");
  return JSON.stringify({
    id: spec.id,
    create_time: "2026-10-04T10:00:00+08:00",
    resource_type: "encrypt-resource",
    event_type: spec.eventType,
    summary: "测试通知",
    resource: {
      original_type: originalType,
      algorithm: "AEAD_AES_256_GCM",
      ciphertext: seal(apiV3Key, JSON.stringify(spec.resource), nonce, originalType),
      associated_data: originalType,
      nonce,
    },
  });
}

/** 支付成功通知解密后的资源（字段照官方文档 4012791902） */
export function transactionResource(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mchid: "1900000109",
    appid: "wx0000000000000000",
    out_trade_no: "FK20261004000001a1b2",
    transaction_id: "4200000000202610040000000001",
    trade_type: "JSAPI",
    trade_state: "SUCCESS",
    trade_state_desc: "支付成功",
    bank_type: "OTHERS",
    attach: "v1.e.o.N.r.12",
    success_time: "2026-10-04T10:00:00+08:00",
    payer: { openid: "o-test-openid-0001" },
    amount: { total: 19900, payer_total: 19900, currency: "CNY", payer_currency: "CNY" },
    ...overrides,
  };
}

/** 退款通知解密后的资源（字段照官方文档 4012791906） */
export function refundResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mchid: "1900000109",
    out_trade_no: "FK20261004000001a1b2",
    transaction_id: "4200000000202610040000000001",
    out_refund_no: "TK20261004000001",
    refund_id: "50000000002026100400000000001",
    refund_status: "SUCCESS",
    success_time: "2026-10-04T11:00:00+08:00",
    user_received_account: "支付用户零钱",
    amount: { total: 19900, refund: 19900, payer_total: 19900, payer_refund: 19900 },
    ...overrides,
  };
}
