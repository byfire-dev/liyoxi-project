// security 用例共用的假密钥：固定字节现造，不读任何文件，不是任何环境在用的密钥（CLAUDE.md 硬性规则 1）。
import { createKeyring } from "../keyring.js";
import type { Keyring, KeyringInput } from "../keyring.js";

/** 32 个相同字节的假密钥 */
export const fakeKey = (fill: number): Buffer => Buffer.alloc(32, fill);

export const KEY_A = fakeKey(0xa1);
export const KEY_B = fakeKey(0xb2);
export const BIDX = { phone: fakeKey(0xc3), uscc: fakeKey(0xd4) };

/** 造密钥环：缺省只有 A，当前是 A */
export const keyringOf = (
  data: KeyringInput["data"] = { current: "a", keys: { a: KEY_A } },
): Keyring => createKeyring({ data, bidx: BIDX });

/** 只有 A */
export const ringA = keyringOf();
/** 轮换之后：当前 B，保留 A */
export const ringBA = keyringOf({ current: "b", keys: { a: KEY_A, b: KEY_B } });
/** 重加密完成、拿掉 A 之后 */
export const ringB = keyringOf({ current: "b", keys: { b: KEY_B } });
