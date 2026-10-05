// 盲索引（W0-14；D4 第 9.2 节）：HMAC-SHA256(K[用途], 归一化(值))，32 字节，存 bytea。
// 支持等值查询与唯一约束，不支持模糊查询。每个用途一把密钥：同一个值在两种用途下算出来不同。
import { createHmac } from "node:crypto";

import type { BidxPurpose, Keyring } from "./keyring.js";

/**
 * 手机号归一化：只留数字，去掉 +86。写了 +86、0086，或 13 位且以 861 开头的，都当作带了国家码。
 * V1.0 只有中国大陆的手机号；别的国家码不处理，原样留数字。
 */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("0086")) return digits.slice(4);
  const withCountryCode =
    phone.trim().startsWith("+") || (digits.length === 13 && digits[2] === "1");
  return withCountryCode && digits.startsWith("86") ? digits.slice(2) : digits;
}

/** 统一社会信用代码归一化：去空白，转大写 */
export function normalizeUscc(uscc: string): string {
  return uscc.replace(/\s/g, "").toUpperCase();
}

const NORMALIZE: Record<BidxPurpose, (value: string) => string> = {
  phone: normalizePhone,
  uscc: normalizeUscc,
};

/** 盲索引的值：32 字节。类型与 Prisma 的 Bytes 列对得上，可以直接写库、直接当查询条件 */
export type BlindIndex = Buffer<ArrayBuffer>;

/** 算盲索引：先按用途归一化，再 HMAC。任何输入都给出 32 字节；值合不合法由调用方先校验 */
export function blindIndex(keyring: Keyring, purpose: BidxPurpose, value: string): BlindIndex {
  const normalized = NORMALIZE[purpose](value);
  const digest = createHmac("sha256", keyring.bidxKey(purpose)).update(normalized, "utf8").digest();
  return Buffer.from(digest);
}
