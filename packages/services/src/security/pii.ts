// 敏感字段三件套（W0-14；06 第 3.2 节；D4 第 9.2、9.3 节）：密文 <名>_enc、盲索引 <名>_bidx、脱敏串 <名>_mask。
// 入库的明文先归一化（手机号只留数字、信用代码去空白转大写、银行账号去空白），脱敏串调 shared 的纯函数。
// 密文与盲索引不出接口（约定 C15）；接口只给脱敏串。解密只在 security 与各模块的仓储层调用。
import { maskBankAccount, maskPhone, maskUscc } from "@liyoxi/shared/mask";

import { blindIndex, normalizePhone, normalizeUscc } from "./bidx.js";
import type { BlindIndex } from "./bidx.js";
import { decryptField, encryptField } from "./crypto.js";
import type { SensitiveColumn } from "./crypto.js";
import type { Keyring } from "./keyring.js";

/** 三件套：密文、盲索引、脱敏串 */
export interface SealedField {
  readonly enc: string;
  readonly bidx: BlindIndex;
  readonly mask: string;
}

/** 手机号的三件套，另带后四位（后台按后四位检索用的明文列 <名>_last4） */
export interface SealedPhone extends SealedField {
  readonly last4: string;
}

/** 手机号 → 三件套加后四位。column 写密文所在的列，如 merchant_user.phone_enc */
export function sealPhone(keyring: Keyring, column: SensitiveColumn, phone: string): SealedPhone {
  const normalized = normalizePhone(phone);
  return {
    enc: encryptField(keyring, column, normalized),
    bidx: blindIndex(keyring, "phone", normalized),
    mask: maskPhone(normalized),
    last4: normalized.slice(-4),
  };
}

/** 统一社会信用代码 → 三件套 */
export function sealUscc(keyring: Keyring, column: SensitiveColumn, uscc: string): SealedField {
  const normalized = normalizeUscc(uscc);
  return {
    enc: encryptField(keyring, column, normalized),
    bidx: blindIndex(keyring, "uscc", normalized),
    mask: maskUscc(normalized),
  };
}

/** 银行账号 → 密文与脱敏串。不按它等值查找，没有盲索引 */
export function sealBankAccount(
  keyring: Keyring,
  column: SensitiveColumn,
  account: string,
): Omit<SealedField, "bidx"> {
  const normalized = account.replace(/\s/g, "");
  return { enc: encryptField(keyring, column, normalized), mask: maskBankAccount(normalized) };
}

/** 按手机号等值查找用的盲索引（+86 写法与纯数字写法相同） */
export const phoneBidx = (keyring: Keyring, phone: string): BlindIndex =>
  blindIndex(keyring, "phone", phone);

/** 按统一社会信用代码等值查找用的盲索引 */
export const usccBidx = (keyring: Keyring, uscc: string): BlindIndex =>
  blindIndex(keyring, "uscc", uscc);

/** 解出一个字段的明文。只有 security 与各模块的仓储层调它 */
export const openField = (keyring: Keyring, column: SensitiveColumn, enc: string): string =>
  decryptField(keyring, column, enc);
