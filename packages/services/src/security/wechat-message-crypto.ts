import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { ErrorSymbol } from "@liyoxi/contract/errors";

type CryptoError = Extract<
  ErrorSymbol,
  | "WEBHOOK_SIGNATURE_INVALID"
  | "WEBHOOK_TIMESTAMP_SKEWED"
  | "WEBHOOK_DECRYPT_FAILED"
  | "WEBHOOK_PAYLOAD_INVALID"
>;
export type WechatMessageCryptoResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: CryptoError };
export interface WechatMessageCryptoConfig {
  readonly token: string;
  readonly encodingAESKey: string;
  readonly appid: string;
  readonly randomBytes?: (size: number) => Uint8Array;
}
interface QueryInput {
  readonly query: Readonly<Record<string, unknown>>;
  readonly now: Date;
}
export interface WechatEncryptedReply {
  readonly Encrypt: string;
  readonly MsgSignature: string;
  readonly TimeStamp: number;
  readonly Nonce: string;
}
export interface WechatDecryptedPost {
  readonly message: Readonly<Record<string, unknown>>;
  readonly plaintextDigest: string;
}

// 私有实施防御值，不是平台最大值，也不是 HTTP 流读取的限制。
const BODY_BYTES = 128 * 1024;
const MESSAGE_BYTES = 64 * 1024;
const CIPHER_BYTES = Math.ceil((20 + MESSAGE_BYTES + 128 + 32) / 32) * 32;
const ascii = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  /^[\x21-\x7e]+$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const field = (value: unknown, key: string): string | null =>
  object(value) && Object.hasOwn(value, key) && typeof value[key] === "string" ? value[key] : null;
const fail = (error: CryptoError): WechatMessageCryptoResult<never> => ({ ok: false, error });
const invalid = () => fail("WEBHOOK_PAYLOAD_INVALID");
const success = <T>(value: T): WechatMessageCryptoResult<T> => ({ ok: true, value });
const utf8 = new TextDecoder("utf-8", { fatal: true });

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const root: unknown = JSON.parse(text);
    if (!object(root)) return null;
    const stack: { value: object; depth: number }[] = [{ value: root, depth: 1 }];
    while (stack.length) {
      const node = stack.pop();
      if (!node || node.depth > 32) return null;
      for (const value of Object.values(node.value)) {
        if (value !== null && typeof value === "object")
          stack.push({ value, depth: node.depth + 1 });
      }
    }
    return root;
  } catch {
    return null;
  }
}
function decodeBase64(text: string, maximum: number): Buffer | null {
  if (
    !text ||
    text.length > Math.ceil(maximum / 3) * 4 ||
    text.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(text)
  )
    return null;
  const decoded = Buffer.from(text, "base64");
  return decoded.length <= maximum && decoded.toString("base64") === text ? decoded : null;
}
function clockMs(now: Date): number | null {
  const value = now instanceof Date ? now.getTime() : NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function timestampSeconds(text: string | null): number | null {
  if (text === null || !/^(0|[1-9]\d{0,12})$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value * 1000) && value * 1000 <= 8.64e15 ? value : null;
}
function digest(parts: readonly string[]): Buffer {
  return createHash("sha1")
    .update([...parts].sort().join(""), "utf8")
    .digest();
}
function matches(signature: string, parts: readonly string[]): boolean {
  return timingSafeEqual(Buffer.from(signature, "hex"), digest(parts));
}
const hex = (value: unknown): value is string =>
  typeof value === "string" && /^[a-fA-F0-9]{40}$/.test(value);

/** 私有协议叶：不查环境、不外呼、不持久化，也不把明文作为 webhook payload。 */
export function createWechatMessageCrypto(config: WechatMessageCryptoConfig) {
  const candidateToken = field(config, "token");
  const candidateAppid = field(config, "appid");
  const encodingAESKey = field(config, "encodingAESKey");
  const candidateKey =
    encodingAESKey !== null && /^[A-Za-z0-9+/]{43}$/.test(encodingAESKey)
      ? decodeBase64(encodingAESKey + "=", 32)
      : null;
  if (
    !ascii(candidateToken, 128) ||
    !ascii(candidateAppid, 128) ||
    !candidateKey ||
    candidateKey.length !== 32 ||
    (config.randomBytes !== undefined && typeof config.randomBytes !== "function")
  )
    throw new TypeError("微信消息加密配置非法");
  const token = candidateToken;
  const key = candidateKey;
  const appidBytes = Buffer.from(candidateAppid);
  const iv = key.subarray(0, 16);
  const random = config.randomBytes ?? randomBytes;

  function verifyGet(input: QueryInput): WechatMessageCryptoResult<string> {
    const signature = field(input.query, "signature");
    const timestamp = field(input.query, "timestamp");
    const nonce = field(input.query, "nonce");
    const echostr = field(input.query, "echostr");
    const seconds = timestampSeconds(timestamp);
    const current = clockMs(input.now);
    if (
      !hex(signature) ||
      seconds === null ||
      current === null ||
      !ascii(nonce, 256) ||
      echostr === null ||
      echostr.length > 4096 ||
      Buffer.byteLength(echostr, "utf8") > 4096 ||
      Buffer.from(echostr, "utf8").toString("utf8") !== echostr
    )
      return invalid();
    if (!matches(signature, [token, timestamp as string, nonce]))
      return fail("WEBHOOK_SIGNATURE_INVALID");
    if (Math.abs(current - seconds * 1000) > 300_000) return fail("WEBHOOK_TIMESTAMP_SKEWED");
    return success(echostr);
  }

  function decryptPostDetailed(
    input: QueryInput & { readonly rawBody: Uint8Array },
  ): WechatMessageCryptoResult<WechatDecryptedPost> {
    const signature = field(input.query, "msg_signature");
    const timestamp = field(input.query, "timestamp");
    const nonce = field(input.query, "nonce");
    const seconds = timestampSeconds(timestamp);
    const current = clockMs(input.now);
    if (
      !hex(signature) ||
      seconds === null ||
      current === null ||
      !ascii(nonce, 256) ||
      !ascii(field(input.query, "signature"), 256) ||
      field(input.query, "encrypt_type") !== "aes" ||
      !(input.rawBody instanceof Uint8Array) ||
      input.rawBody.byteLength > BODY_BYTES
    )
      return invalid();
    let outer: Record<string, unknown> | null;
    try {
      outer = parseObject(utf8.decode(input.rawBody));
    } catch {
      return invalid();
    }
    const encoded = field(outer, "Encrypt");
    if (!ascii(field(outer, "ToUserName"), 128) || encoded === null) return invalid();
    const ciphertext = decodeBase64(encoded, CIPHER_BYTES);
    if (!ciphertext || ciphertext.length === 0 || ciphertext.length % 32 !== 0) return invalid();
    if (!matches(signature, [token, timestamp as string, nonce, encoded]))
      return fail("WEBHOOK_SIGNATURE_INVALID");
    if (Math.abs(current - seconds * 1000) > 300_000) return fail("WEBHOOK_TIMESTAMP_SKEWED");

    let message: Buffer;
    try {
      const decipher = createDecipheriv("aes-256-cbc", key, iv);
      decipher.setAutoPadding(false);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const pad = decrypted[decrypted.length - 1];
      if (pad === undefined || pad < 1 || pad > 32 || pad > decrypted.length)
        return fail("WEBHOOK_DECRYPT_FAILED");
      for (let i = decrypted.length - pad; i < decrypted.length; i++) {
        if (decrypted[i] !== pad) return fail("WEBHOOK_DECRYPT_FAILED");
      }
      const plain = decrypted.subarray(0, decrypted.length - pad);
      if (plain.length < 20) return fail("WEBHOOK_DECRYPT_FAILED");
      const length = plain.readUInt32BE(16);
      if (length > plain.length - 20) return fail("WEBHOOK_DECRYPT_FAILED");
      const receiver = plain.subarray(20 + length);
      if (receiver.length !== appidBytes.length || !timingSafeEqual(receiver, appidBytes))
        return fail("WEBHOOK_SIGNATURE_INVALID");
      if (length > MESSAGE_BYTES) return invalid();
      message = plain.subarray(20, 20 + length);
    } catch {
      return fail("WEBHOOK_DECRYPT_FAILED");
    }
    try {
      const value = parseObject(utf8.decode(message));
      return value === null
        ? invalid()
        : success({
            message: value,
            plaintextDigest: createHash("sha256").update(message).digest("hex"),
          });
    } catch {
      return invalid();
    }
  }

  function decryptPost(
    input: QueryInput & { readonly rawBody: Uint8Array },
  ): WechatMessageCryptoResult<Readonly<Record<string, unknown>>> {
    const result = decryptPostDetailed(input);
    return result.ok ? success(result.value.message) : result;
  }

  function encryptReply(input: {
    readonly plaintext: string;
    readonly nonce: string;
    readonly now: Date;
  }): WechatMessageCryptoResult<WechatEncryptedReply> {
    const current = clockMs(input.now);
    if (
      current === null ||
      !ascii(input.nonce, 256) ||
      typeof input.plaintext !== "string" ||
      input.plaintext.length > MESSAGE_BYTES ||
      Buffer.byteLength(input.plaintext, "utf8") > MESSAGE_BYTES ||
      parseObject(input.plaintext) === null ||
      Buffer.from(input.plaintext, "utf8").toString("utf8") !== input.plaintext
    )
      return invalid();
    try {
      const prefix = random(16);
      if (!(prefix instanceof Uint8Array) || prefix.byteLength !== 16)
        return fail("WEBHOOK_DECRYPT_FAILED");
      const message = Buffer.from(input.plaintext, "utf8");
      const length = Buffer.alloc(4);
      length.writeUInt32BE(message.length);
      const frame = Buffer.concat([prefix, length, message, appidBytes]);
      const pad = 32 - (frame.length % 32);
      const cipher = createCipheriv("aes-256-cbc", key, iv);
      cipher.setAutoPadding(false);
      const Encrypt = Buffer.concat([
        cipher.update(Buffer.concat([frame, Buffer.alloc(pad, pad)])),
        cipher.final(),
      ]).toString("base64");
      const TimeStamp = Math.floor(current / 1000);
      const MsgSignature = digest([token, String(TimeStamp), input.nonce, Encrypt]).toString("hex");
      return success({ Encrypt, MsgSignature, TimeStamp, Nonce: input.nonce });
    } catch {
      // 本私有 helper 的统一 crypto 失败；未来 adapter 沿 h01 的固定 HTTP 映射。
      return fail("WEBHOOK_DECRYPT_FAILED");
    }
  }
  return { verifyGet, decryptPost, decryptPostDetailed, encryptReply };
}
