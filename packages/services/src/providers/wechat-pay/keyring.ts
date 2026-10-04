// 验签身份表与 APIv3 密钥环（h01 第 2.1 节第 9、10′ 步，第 3.1 节；D7 第 7.5 节“轮换”）。
//
// 验签身份：Wechatpay-Serial 以 PUB_KEY_ID_ 开头用微信支付公钥，否则用已配置的平台证书（切换期并存）。
// 密钥环：当前一把加上一把。解密先试当前、再试上一把，返回实际解开的那把的 kid；
//         重处理时按收件行记下的 kid 指定密钥重新解密。
// 解密算法 AEAD_AES_256_GCM：密文 base64 解码后末 16 字节是认证标签（官方文档 4012071382）。

import { createDecipheriv, createPublicKey, X509Certificate } from "node:crypto";
import type { KeyObject } from "node:crypto";

export const PUBLIC_KEY_ID_PREFIX = "PUB_KEY_ID_";
export const AEAD_ALGORITHM = "AEAD_AES_256_GCM";
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface VerifierEntry {
  /** 微信支付公钥 ID（PUB_KEY_ID_ 开头），或平台证书序列号 */
  serial: string;
  /** 公钥 PEM；平台证书给证书 PEM */
  pem: string;
}

export interface VerifierIdentity {
  serial: string;
  kind: "public-key" | "certificate";
  publicKey: KeyObject;
}

export interface VerifierTable {
  lookup(serial: string): VerifierIdentity | undefined;
}

/** 建验签身份表。写错即抛错（只带序列号，不带密钥内容）：前缀与 PEM 的种类要对得上，证书序列号要与证书一致 */
export function createVerifierTable(entries: readonly VerifierEntry[]): VerifierTable {
  const table = new Map<string, VerifierIdentity>();
  for (const { serial, pem } of entries) {
    const isCertificate = pem.includes("BEGIN CERTIFICATE");
    if (serial.startsWith(PUBLIC_KEY_ID_PREFIX) === isCertificate) {
      throw new Error(`验签身份 ${serial}：公钥 ID 要配公钥，平台证书序列号要配证书`);
    }
    if (!isCertificate) {
      table.set(serial, { serial, kind: "public-key", publicKey: createPublicKey(pem) });
      continue;
    }
    const certificate = new X509Certificate(pem);
    if (certificate.serialNumber.toUpperCase() !== serial.toUpperCase()) {
      throw new Error(`验签身份 ${serial}：与证书里的序列号不一致`);
    }
    table.set(serial, { serial, kind: "certificate", publicKey: certificate.publicKey });
  }
  return { lookup: (serial) => table.get(serial) };
}

/** 回调报文里的 resource，键名保持微信的写法 */
export interface ResourceCipher {
  algorithm: string;
  ciphertext: string;
  nonce: string;
  associated_data?: string;
  original_type?: string;
}

/** 用一把 APIv3 密钥解密。解不开（密钥不对、密文被改、不是规范的 base64）返回 null，不抛错 */
export function aeadDecrypt(key: Uint8Array, resource: ResourceCipher): string | null {
  const bytes = Buffer.from(resource.ciphertext, "base64");
  if (bytes.toString("base64") !== resource.ciphertext || bytes.length <= TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(resource.nonce));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    decipher.setAAD(Buffer.from(resource.associated_data ?? ""));
    const head = decipher.update(bytes.subarray(0, bytes.length - TAG_BYTES));
    return Buffer.concat([head, decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export interface ApiV3Key {
  /** 密钥版本，写进收件行的 key_version */
  kid: string;
  /** APIv3 密钥：32 个字节 */
  key: string;
}

export interface ApiV3Keyring {
  /** 给了 kid 只用那一把；不给则先试当前、再试上一把。都解不开返回 null */
  decrypt(resource: ResourceCipher, kid?: string): { kid: string; plaintext: string } | null;
}

export function createApiV3Keyring(current: ApiV3Key, previous?: ApiV3Key): ApiV3Keyring {
  const ring = [current, ...(previous ? [previous] : [])].map(({ kid, key }) => {
    const bytes = Buffer.from(key, "utf8");
    if (bytes.length !== KEY_BYTES) throw new Error(`APIv3 密钥 ${kid}：长度必须是 32 个字节`);
    return { kid, bytes };
  });
  if (previous && previous.kid === current.kid) throw new Error("APIv3 密钥的两把 kid 相同");
  return {
    decrypt(resource, kid) {
      for (const entry of ring) {
        if (kid !== undefined && entry.kid !== kid) continue;
        const plaintext = aeadDecrypt(entry.bytes, resource);
        if (plaintext !== null) return { kid: entry.kid, plaintext };
      }
      return null;
    },
  };
}
