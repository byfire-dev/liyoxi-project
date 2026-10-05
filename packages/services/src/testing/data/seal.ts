// 敏感字段三件套的注入点，与测试专用的假实现（W0-25）。
//
// 工厂写手机号、统一社会信用代码这些列时不自己拼密文，调注入进来的 seal（createFactories 的 seal 选项）。
// 形状照 W0-14 的 security 模块：sealPhone(keyring, column, phone)、sealUscc(…)、encryptField(…) 去掉 keyring 一参。
// 缺省是下面的假三件套：W0-14 还没合并，本包的基上没有真的。它合并后把缺省换成真的（状态文件记了这件事），
// 在那之前要真密文的用例自己注入：
//   createFactories({ db, clock, seal: {
//     phone: (column, phone) => sealPhone(keyring, column, phone),
//     uscc: (column, uscc) => sealUscc(keyring, column, uscc),
//     text: (column, plaintext) => encryptField(keyring, column, plaintext),
//   } })
//
// 假三件套：密文是 fake-v0:<base64url(列名 + 换行 + 明文)>，一眼看得出不是真的，openFakeSealed 能解回来；
// 盲索引是 SHA-256(用途 + 归一化的值)，32 字节，同值同索引，过得了库里的长度检查与唯一索引；
// 脱敏串调 shared 的纯函数，与真的一样。没有密钥，不能拿去验加密本身。
import { createHash } from "node:crypto";

import { maskPhone, maskUscc } from "@liyoxi/shared/mask";

/** 密文所在的列，写成 表名.列名（如 merchant_user.phone_enc） */
export type SensitiveColumn = `${string}.${string}`;

/** 三件套：密文、盲索引、脱敏串 */
export interface SealedField {
  readonly enc: string;
  readonly bidx: Buffer<ArrayBuffer>;
  readonly mask: string;
}

/** 手机号的三件套，另带后四位 */
export interface SealedPhone extends SealedField {
  readonly last4: string;
}

export interface FactorySealer {
  phone(column: SensitiveColumn, phone: string): SealedPhone;
  uscc(column: SensitiveColumn, uscc: string): SealedField;
  /** 只存密文的字段（如法定代表人姓名） */
  text(column: SensitiveColumn, plaintext: string): string;
}

const FAKE_PREFIX = "fake-v0:";

const fakeEnc = (column: SensitiveColumn, plaintext: string): string =>
  `${FAKE_PREFIX}${Buffer.from(`${column}\n${plaintext}`, "utf8").toString("base64url")}`;

const fakeBidx = (purpose: string, normalized: string): Buffer<ArrayBuffer> =>
  Buffer.from(createHash("sha256").update(`lyx-fake-bidx\n${purpose}\n${normalized}`).digest());

/** 只留数字，去掉 +86 */
const normalizePhone = (phone: string): string => {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 13 && digits.startsWith("86") ? digits.slice(2) : digits;
};

/** 测试专用的假三件套。W0-14 合并后 createFactories 的缺省换成真的 */
export const fakeSealer: FactorySealer = {
  phone(column, phone) {
    const normalized = normalizePhone(phone);
    return {
      enc: fakeEnc(column, normalized),
      bidx: fakeBidx("phone", normalized),
      mask: maskPhone(normalized),
      last4: normalized.slice(-4),
    };
  },
  uscc(column, uscc) {
    const normalized = uscc.replace(/\s/g, "").toUpperCase();
    return {
      enc: fakeEnc(column, normalized),
      bidx: fakeBidx("uscc", normalized),
      mask: maskUscc(normalized),
    };
  },
  text: fakeEnc,
};

/** 解开假密文：给出当初的列名与明文。不是假三件套写的即抛错 */
export function openFakeSealed(enc: string): { column: string; plaintext: string } {
  if (!enc.startsWith(FAKE_PREFIX)) throw new Error("不是假三件套写的密文（不以 fake-v0: 开头）");
  const text = Buffer.from(enc.slice(FAKE_PREFIX.length), "base64url").toString("utf8");
  const cut = text.indexOf("\n");
  return { column: text.slice(0, cut), plaintext: text.slice(cut + 1) };
}
