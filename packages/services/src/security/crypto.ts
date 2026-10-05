// 字段加密（W0-14；D4 第 9.2 节；02 分组 第 1 节）：AES-256-GCM，随机 12 字节 IV，AAD = 表名.列名。
// 密文是文本 v1:<kid>:<base64url(iv ‖ 密文 ‖ tag)>，存 text 列。加密用当前那把密钥，解密按 kid 取：
// 轮换时新旧并存，旧 kid 的密文照样能解；旧密钥从密钥环里拿掉之后解不了，报 unknown_kid。
// 只用 node:crypto。没有借参考工程的代码：任务书 第 12 节的两个候选没有打开，照上面的依据直接写的。
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { SecurityError } from "./keyring.js";
import type { Keyring } from "./keyring.js";

/** 密文所在的列，写成 表名.列名（如 merchant_user.phone_enc）。进 AAD：密文挪到别的列解不开 */
export type SensitiveColumn = `${string}.${string}`;

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CIPHERTEXT = /^v1:([^:]+):([A-Za-z0-9_-]+)$/;
/** 带 u 标志时只匹配不成对的代理项；成对的算一个码点，不命中 */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** 加密一个字段的明文。明文里有不成对的代理项即抛错：它过不了 UTF-8，解出来会与原文不同 */
export function encryptField(keyring: Keyring, column: SensitiveColumn, plaintext: string): string {
  if (LONE_SURROGATE.test(plaintext)) {
    throw new SecurityError("plaintext_invalid", "明文不是合法的 Unicode 文本（有不成对的代理项）");
  }
  const kid = keyring.currentKid;
  const key = keyring.dataKey(kid);
  if (key === undefined) throw new SecurityError("unknown_kid", `密钥环里没有当前密钥 ${kid}`);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(column, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const sealed = Buffer.concat([iv, body, cipher.getAuthTag()]);
  return `v1:${kid}:${sealed.toString("base64url")}`;
}

/** 密文用的是哪把密钥；不是 v1 的写法返回 undefined。重加密任务用它挑出还在用旧密钥的行 */
export function kidOf(ciphertext: string): string | undefined {
  return CIPHERTEXT.exec(ciphertext)?.[1];
}

/** 解密。只有 security 与各模块的仓储层调它（D4 第 9.2 节） */
export function decryptField(
  keyring: Keyring,
  column: SensitiveColumn,
  ciphertext: string,
): string {
  const match = CIPHERTEXT.exec(ciphertext);
  const sealed = Buffer.from(match?.[2] ?? "", "base64url");
  if (match === null || sealed.length < IV_BYTES + TAG_BYTES) {
    throw new SecurityError(
      "ciphertext_format",
      `${column} 的密文不是 v1:<kid>:<base64url> 的写法`,
    );
  }
  const kid = match[1] as string;
  const key = keyring.dataKey(kid);
  if (key === undefined) {
    throw new SecurityError(
      "unknown_kid",
      `${column} 的密文用的密钥 ${kid} 不在密钥环里：旧密钥要留到重加密完成之后才能拿掉`,
    );
  }
  const decipher = createDecipheriv(ALGORITHM, key, sealed.subarray(0, IV_BYTES), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(column, "utf8"));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    const body = sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    throw new SecurityError(
      "decrypt_failed",
      `${column} 的密文解不开：密文被改过、不属于这一列，或密钥不对`,
    );
  }
}
